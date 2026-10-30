import { Client, neon } from "@neondatabase/serverless";
import { drizzle as httpDrizzle } from "drizzle-orm/neon-http";
import {
  drizzle as socketDrizzle,
  type NeonDatabase,
} from "drizzle-orm/neon-serverless";
import type { SQL } from "drizzle-orm";
import { StoreError } from "./errors";

export interface StoreSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: SQL,
  ): Promise<Row[]>;
}
export interface StoreDatabase extends StoreSession {
  transaction<T>(work: (tx: StoreSession) => Promise<T>): Promise<T>;
  withConnection<T>(work: (db: StoreDatabase) => Promise<T>): Promise<T>;
}

const triggerRefusals = new Map<string, { message: string; status: number }>([
  [
    "recipe_recovery_invalid",
    { message: "Recovery must copy an eligible stored version.", status: 422 },
  ],
  [
    "recipe_version_conflict",
    {
      message: "The recipe version conflicts with the current recipe.",
      status: 409,
    },
  ],
  [
    "recipe_version_is_immutable",
    { message: "Recipe versions cannot be changed.", status: 409 },
  ],
  [
    "recipe_metadata_is_immutable",
    { message: "Recipe metadata cannot be changed.", status: 409 },
  ],
  [
    "recipe_history_limit",
    { message: "The recipe history limit has been reached.", status: 422 },
  ],
  [
    "recipe_body_limit",
    { message: "The recipe body exceeds its size limit.", status: 422 },
  ],
  [
    "recipe_description_limit",
    { message: "The recipe description exceeds its size limit.", status: 422 },
  ],
  [
    "recipe_reason_limit",
    { message: "The recipe reason exceeds its size limit.", status: 422 },
  ],
  [
    "recipe_name_limit",
    { message: "The recipe name exceeds its size limit.", status: 422 },
  ],
  [
    "recipe_count_limit",
    { message: "The recipe count limit has been reached.", status: 422 },
  ],
  [
    "account_unavailable",
    { message: "This Milton account is unavailable.", status: 403 },
  ],
  [
    "user_id_is_immutable",
    { message: "The Milton user id cannot be changed.", status: 409 },
  ],
]);

export function databaseFailure(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  const seen = new Set<object>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    if ("code" in error) {
      if (error.code === "23505")
        return new StoreError(
          "unique_violation",
          "A record with these identifiers already exists.",
          409,
        );
      if (error.code === "23514")
        return new StoreError(
          "check_violation",
          "The record does not meet the store requirements.",
          422,
        );
      if (
        error.code === "P0001" &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        const refusal = triggerRefusals.get(error.message);
        if (refusal)
          return new StoreError(error.message, refusal.message, refusal.status);
      }
    }
    error = "cause" in error ? error.cause : undefined;
  }
  return new StoreError(
    "store_unavailable",
    "The recipe store is unavailable. Try again.",
  );
}

export function validateDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      /[\r\n\0]/.test(value) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      decodeURIComponent(url.pathname) !== "/milton" ||
      !["require", "verify-full", "verify-ca"].includes(
        url.searchParams.get("sslmode") ?? "require",
      )
    )
      throw new Error();
    return value;
  } catch {
    throw new StoreError(
      "configuration",
      "DATABASE_URL must select the milton Postgres database with TLS.",
    );
  }
}

// One operation owns one client. No host bindings, global connections or host lifecycle APIs.
export async function withNeonClient<T>(
  url: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: validateDatabaseUrl(url),
    connectionTimeoutMillis: 10000,
    query_timeout: 20000,
  });
  client.on("error", () => {
    /* The operation boundary reports a bounded failure. */
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    try {
      await client.end();
    } catch {
      throw databaseFailure(undefined);
    }
  }
}

function socketSession(executor: Pick<NeonDatabase, "execute">): StoreSession {
  return {
    async query<Row extends Record<string, unknown>>(statement: SQL) {
      try {
        // Drizzle's conditional driver result type cannot reduce a generic Row in TS 7.
        return (await executor.execute<Row>(statement)).rows as Row[];
      } catch (error) {
        throw databaseFailure(error);
      }
    },
  };
}

function socketDatabase(client: Client): StoreDatabase {
  const db = socketDrizzle(client);
  const connection: StoreDatabase = {
    ...socketSession(db),
    async transaction(work) {
      let callbackFailure: { error: unknown } | undefined;
      try {
        return await db.transaction(
          async (tx) => {
            await tx.execute("SET LOCAL lock_timeout = '10s'");
            await tx.execute("SET LOCAL statement_timeout = '20s'");
            try {
              return await work(socketSession(tx));
            } catch (error) {
              callbackFailure = { error };
              throw error;
            }
          },
          { isolationLevel: "read committed" },
        );
      } catch (error) {
        if (callbackFailure && error === callbackFailure.error) throw error;
        throw databaseFailure(error);
      }
    },
    withConnection: (work) => work(connection),
  };
  return connection;
}

export function neonDatabase(url: string): StoreDatabase {
  validateDatabaseUrl(url);
  const database: StoreDatabase = {
    async query<Row extends Record<string, unknown>>(statement: SQL) {
      try {
        return (await httpDrizzle(neon(url)).execute<Row>(statement)).rows;
      } catch (error) {
        throw databaseFailure(error);
      }
    },
    async withConnection(work) {
      let callbackFailure: { error: unknown } | undefined;
      try {
        return await withNeonClient(url, async (client) => {
          try {
            return await work(socketDatabase(client));
          } catch (error) {
            callbackFailure = { error };
            throw error;
          }
        });
      } catch (error) {
        if (callbackFailure && error === callbackFailure.error) throw error;
        throw databaseFailure(error);
      }
    },
    transaction: (work) =>
      database.withConnection((connection) => connection.transaction(work)),
  };
  return database;
}
