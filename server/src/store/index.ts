import { z } from "zod";
import { sql } from "drizzle-orm";
import templates from "../../generated/templates.json";
import {
  neonDatabase,
  databaseFailure,
  type StoreDatabase,
  type StoreSession,
} from "./database";
import { StoreError } from "./errors";
import {
  recipeWrites,
  type CreateInput,
  type UpdateInput,
  type ArchiveInput,
} from "./writes";
import { parseVersionTag, versionTag } from "./versions";
export { StoreError } from "./errors";

export interface StoreBindings {
  DATABASE_URL?: string;
  RECIPES_SOURCE?: string;
  // Private dependency injection for the embedded fixture; never populated from a request.
  storeDatabase?: StoreDatabase;
}
export function recipesSource(bindings: StoreBindings) {
  const source = bindings.RECIPES_SOURCE ?? "bundle";
  if (source !== "bundle" && source !== "store")
    throw new StoreError(
      "configuration",
      "RECIPES_SOURCE must be bundle or store.",
    );
  return source;
}
function database(bindings: StoreBindings): StoreDatabase {
  if (bindings.storeDatabase) return bindings.storeDatabase;
  if (!bindings.DATABASE_URL)
    throw new StoreError("configuration", "The recipe store is unavailable.");
  return neonDatabase(bindings.DATABASE_URL);
}
const positiveLimit = z.number().int().positive();
const limitsSchema = z.object({
  recipes: positiveLimit,
  body_bytes: positiveLimit,
  name_bytes: positiveLimit,
  description_bytes: positiveLimit,
  reason_bytes: positiveLimit,
  history_bytes: positiveLimit,
  daily_calls: positiveLimit,
  daily_writes: positiveLimit,
  request_bytes: positiveLimit,
  page_size: positiveLimit.max(50),
});
export type StoreLimits = z.infer<typeof limitsSchema>;

export async function readLimits(db: StoreSession): Promise<StoreLimits> {
  let value: unknown;
  try {
    value = (
      await db.query<{ limits_json: unknown }>(
        sql`SELECT limits_json FROM store_config WHERE singleton = 1`,
      )
    )[0]?.limits_json;
  } catch (error) {
    throw databaseFailure(error);
  }
  const result = limitsSchema.safeParse(value);
  if (!result.success)
    throw new StoreError(
      "configuration",
      "The recipe store limits are invalid.",
    );
  return result.data;
}
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).length;

export interface VerifiedIdentity {
  provider: string;
  subject: string;
  profile?: Record<string, unknown>;
}

export async function resolveIdentityAccount(
  bindings: StoreBindings,
  identity: VerifiedIdentity,
) {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  return database(bindings)
    .transaction(async (tx) => {
      await readLimits(tx);
      const lookup = () =>
        tx.query<{
          id: string;
          status: string;
          templates_revision: number;
        }>(sql`
      SELECT u.id, u.status, u.templates_revision FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ${provider} AND i.subject = ${subject} FOR UPDATE OF u`);
      let account = (await lookup())[0];
      if (!account) {
        const config = (
          await tx.query<{
            signup_mode: string;
            allowed_identities_json: unknown;
          }>(sql`
        SELECT signup_mode, allowed_identities_json FROM store_config WHERE singleton = 1 FOR UPDATE`)
        )[0];
        // A separate READ COMMITTED statement sees an admission that committed while this request waited.
        account = (await lookup())[0];
        if (!account) {
          const allowed = z
            .array(z.object({ provider: z.string(), subject: z.string() }))
            .parse(config?.allowed_identities_json);
          if (
            !config ||
            !(
              config.signup_mode === "open" ||
              (config.signup_mode === "allowlist" &&
                allowed.some(
                  (item) =>
                    item.provider === provider && item.subject === subject,
                ))
            )
          )
            throw new StoreError(
              "admission_refused",
              "New Milton accounts are closed.",
              403,
            );
          const id = `m_${crypto.randomUUID()}`;
          await tx.query(sql`INSERT INTO users (id) VALUES (${id})`);
          await tx.query(sql`INSERT INTO identities (provider,subject,user_id,profile_json)
          VALUES (${provider},${subject},${id},${JSON.stringify(identity.profile ?? {})}::jsonb)`);
          account = { id, status: "active", templates_revision: 0 };
        }
      }
      if (account.status !== "active")
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      if (account.templates_revision === 0) {
        for (const template of templates) {
          const recipe =
            (
              await tx.query<{
                id: string;
              }>(sql`INSERT INTO recipes (user_id,name)
          VALUES (${account.id},${template.name}) ON CONFLICT (user_id,name) DO NOTHING RETURNING id`)
            )[0] ??
            (
              await tx.query<{ id: string }>(
                sql`SELECT id FROM recipes WHERE user_id = ${account.id} AND name = ${template.name}`,
              )
            )[0]!;
          if (
            !(
              await tx.query(
                sql`SELECT version FROM recipe_versions WHERE user_id = ${account.id} AND recipe_id = ${recipe.id}`,
              )
            ).length
          )
            await tx.query(sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json,details_json)
            VALUES (${account.id},${recipe.id},1,${template.description},${template.body},'Initial template',
            ${JSON.stringify({ kind: "system", id: "template-seed" })},${JSON.stringify({ kind: "seed", templateRevision: 1 })})`);
        }
        await tx.query(
          sql`UPDATE users SET templates_revision = 1 WHERE id = ${account.id}`,
        );
      }
      return { miltonUserId: account.id };
    })
    .catch((error) => {
      throw databaseFailure(error);
    });
}

const verifiedStoreIdentity = Symbol("verifiedStoreIdentity");
export interface VerifiedStoreAuth {
  readonly userId: string;
  readonly [verifiedStoreIdentity]: true;
}

export async function lookupIdentityAccount(
  bindings: StoreBindings,
  identity: Pick<VerifiedIdentity, "provider" | "subject">,
): Promise<VerifiedStoreAuth> {
  const provider = z.string().min(1).max(64).parse(identity.provider);
  const subject = z.string().min(1).max(512).parse(identity.subject);
  try {
    const account = (
      await database(bindings).query<{ id: string }>(sql`
        SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id
        WHERE i.provider=${provider} AND i.subject=${subject} AND u.status='active'`)
    )[0];
    if (!account)
      throw new StoreError(
        "account_unavailable",
        "Sign in to Milton before connecting your assistant.",
        403,
      );
    return { userId: account.id, [verifiedStoreIdentity]: true };
  } catch (error) {
    throw databaseFailure(error);
  }
}

export type RecipeSummary = {
  name: string;
  description: string;
  version: string;
};
export interface RecipeSnapshot extends RecipeSummary {
  text: string;
  archived: boolean;
}
type SummaryRow = {
  name: string;
  description: string;
  version: number;
  id: string;
};
type SnapshotRow = SummaryRow & {
  body: string;
  archived: boolean;
};
export interface StorePage<T> {
  items: T[];
  next_cursor: string | null;
}
export interface SearchHit extends RecipeSummary {
  snippets: string[];
}
export type CallAllowance =
  { allowed: true } | { allowed: false; retry_at_ms: number; limit: "day" };
export interface TenantStore {
  createRecipe(input: CreateInput): Promise<RecipeSnapshot>;
  updateRecipe(input: UpdateInput): Promise<RecipeSnapshot>;
  archiveRecipe(input: ArchiveInput): Promise<RecipeSnapshot>;
  listRecipes(
    cursor?: string,
    archived?: boolean,
    excludeVibes?: boolean,
  ): Promise<StorePage<RecipeSummary>>;
  getRecipe(name: string): Promise<RecipeSnapshot | null>;
  getVibes(): Promise<RecipeSnapshot>;
  search(words: string, cursor?: string): Promise<StorePage<SearchHit>>;
  chargeToolCall(): Promise<CallAllowance>;
}

const summary = (row: SummaryRow): RecipeSummary => ({
  name: row.name,
  description: row.description,
  version: versionTag(row.name, row.version, row.id),
});
const snapshot = (row: SnapshotRow): RecipeSnapshot => ({
  ...summary(row),
  text: row.body,
  archived: row.archived,
});
const cursorSchema = z.object({
  tool: z.enum(["list", "search"]),
  after: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  query: z.string().max(256),
});

function readCursor(
  value: string | undefined,
  tool: "list" | "search",
  query = "",
) {
  if (!value) return "";
  try {
    if (value.length > 2048) throw new Error();
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
      ),
    );
    const cursor = cursorSchema.parse(decoded);
    if (cursor.tool !== tool || cursor.query !== query) throw new Error();
    return cursor.after;
  } catch {
    throw new StoreError(
      "invalid_cursor",
      "Start this list or search again with no cursor.",
      400,
    );
  }
}

function nextCursor(tool: "list" | "search", after: string, query = "") {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(JSON.stringify({ tool, after, query })),
    ),
  );
}

function snippetsFor(text: string, query: string) {
  const folded = text.toLowerCase();
  const snippets: string[] = [];
  let offset = 0;
  while (snippets.length < 3) {
    const index = folded.indexOf(query, offset);
    if (index === -1) break;
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + query.length + 60);
    snippets.push(
      `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    );
    offset = index + query.length;
  }
  return snippets;
}

async function resolveActiveUser(db: StoreSession, userId: string) {
  const account = (
    await db.query<{ id: string }>(
      sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active'`,
    )
  )[0];
  if (!account)
    throw new StoreError(
      "account_unavailable",
      "This Milton account is unavailable.",
      403,
    );
  return account.id;
}

export async function storeForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
  assistant?: { issuer: string; clientId: string },
): Promise<TenantStore> {
  const userId = auth.userId;
  const db = database(bindings);
  const limits = await readLimits(db);
  await resolveActiveUser(db, userId);
  const currentSnapshot = sql`FROM recipes r JOIN recipe_versions v ON v.user_id = r.user_id AND v.recipe_id = r.id
    WHERE r.user_id = ${userId} AND v.version = (SELECT max(current.version) FROM recipe_versions current
      WHERE current.user_id = r.user_id AND current.recipe_id = r.id)
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId} AND u.status = 'active')`;
  async function getRecipe(name: string, session: StoreSession = db) {
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      utf8Bytes(name) > limits.name_bytes
    )
      throw new StoreError(
        "invalid_name",
        "Enter a valid recipe name within its byte limit.",
        400,
      );
    const row = (
      await session.query<SnapshotRow>(
        sql`SELECT r.id, r.name, v.description, v.body, v.version, v.archived ${currentSnapshot} AND r.name = ${name}`,
      )
    )[0];
    return row ? snapshot(row) : null;
  }
  return {
    ...recipeWrites(
      db,
      userId,
      assistant
        ? {
            kind: "assistant",
            issuer: assistant.issuer,
            client_id: assistant.clientId,
          }
        : undefined,
    ),
    async listRecipes(cursor, archived = false, excludeVibes = false) {
      const query = excludeVibes ? `${archived}:recipes` : String(archived);
      const after = readCursor(cursor, "list", query);
      const rows =
        await db.query<SummaryRow>(sql`SELECT r.id, r.name, v.description, v.version ${currentSnapshot}
        AND v.archived = ${archived} AND (${!excludeVibes} OR r.name <> 'vibes') AND r.name > ${after} ORDER BY r.name LIMIT ${limits.page_size + 1}`);
      const items = rows.slice(0, limits.page_size).map(summary);
      return {
        items,
        next_cursor:
          rows.length > limits.page_size
            ? nextCursor("list", items.at(-1)!.name, query)
            : null,
      };
    },
    getRecipe,
    async getVibes() {
      const recipe = await getRecipe("vibes");
      if (recipe && !recipe.archived) return recipe;
      return db
        .transaction(async (tx) => {
          if (
            !(
              await tx.query(
                sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
              )
            ).length
          )
            throw new StoreError(
              "account_unavailable",
              "This Milton account is unavailable.",
              403,
            );
          // Serialize repairs with ordinary writes, then recheck under the tenant lock.
          const current = await getRecipe("vibes", tx);
          if (current && !current.archived) return current;
          if (current) {
            const tag = parseVersionTag(current.version)!;
            await tx.query(sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,archived,reason,actor_json,details_json)
            VALUES (${userId},${tag.id},${tag.number + 1},${current.description},${current.text},false,'Restored vibes','{"kind":"system"}',${JSON.stringify({ kind: "restore", source_version: tag.number })})`);
            return (await getRecipe("vibes", tx))!;
          }
          await tx.query(
            sql`INSERT INTO recipes (user_id,name) VALUES (${userId},'vibes') ON CONFLICT (user_id,name) DO NOTHING`,
          );
          const description =
            templates.find((item) => item.name === "vibes")?.description ??
            "How you want your assistants to work with you.";
          await tx.query(sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json,details_json)
          SELECT ${userId},id,1,${description},'','Created vibes','{"kind":"system"}','{"kind":"create"}'
          FROM recipes WHERE user_id=${userId} AND name='vibes'`);
          return (await getRecipe("vibes", tx))!;
        })
        .catch((error) => {
          throw databaseFailure(error);
        });
    },
    async search(words, cursor) {
      const query = words.trim().toLowerCase();
      if (!query || query.length > 256)
        throw new StoreError(
          "invalid_search",
          "Enter between 1 and 256 characters to search.",
          400,
        );
      const after = readCursor(cursor, "search", query);
      const rows =
        await db.query<SnapshotRow>(sql`SELECT r.id, r.name, v.description, v.body, v.version, v.archived ${currentSnapshot}
        AND NOT v.archived AND r.name > ${after} ORDER BY r.name`);
      const matches: SearchHit[] = [];
      for (const row of rows) {
        const snippets = snippetsFor(
          `${row.name}\n${row.description}\n${row.body}`,
          query,
        );
        if (snippets.length) matches.push({ ...summary(row), snippets });
        if (matches.length > limits.page_size) break;
      }
      const items = matches.slice(0, limits.page_size);
      return {
        items,
        next_cursor:
          matches.length > limits.page_size
            ? nextCursor("search", items.at(-1)!.name, query)
            : null,
      };
    },
    async chargeToolCall() {
      return db.transaction(async (tx) => {
        if (
          !(
            await tx.query(
              sql`SELECT id FROM users WHERE id = ${userId} AND status = 'active' FOR UPDATE`,
            )
          ).length
        )
          throw new StoreError(
            "account_unavailable",
            "This Milton account is unavailable.",
            403,
          );
        const { day } = (
          await tx.query<{ day: string }>(
            sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`,
          )
        )[0]!;
        const charged =
          await tx.query(sql`INSERT INTO usage_daily (user_id,day_utc,tool_calls) VALUES (${userId},${day}::date,1)
          ON CONFLICT (user_id,day_utc) DO UPDATE SET tool_calls = usage_daily.tool_calls + 1
          WHERE usage_daily.tool_calls < ${limits.daily_calls} RETURNING tool_calls`);
        return charged.length
          ? { allowed: true as const }
          : {
              allowed: false as const,
              limit: "day" as const,
              retry_at_ms: Date.parse(`${day}T00:00:00Z`) + 86400000,
            };
      });
    },
  };
}

export interface VersionMetadata {
  version: number;
  reason: string;
  actor: Record<string, unknown>;
  created_at: string;
}

export async function personStoreForCurrentRequest(
  bindings: StoreBindings,
  auth: VerifiedStoreAuth,
) {
  const reads = await storeForCurrentRequest(bindings, auth);
  const db = database(bindings);
  const userId = auth.userId;
  const limits = await readLimits(db);
  const active = sql`EXISTS (SELECT 1 FROM users WHERE id=${userId} AND status='active')`;
  const metadata = (row: {
    version: number;
    reason: string;
    actor_json: string;
    created_at: string;
  }): VersionMetadata => ({
    version: row.version,
    reason: row.reason,
    actor: JSON.parse(row.actor_json) as Record<string, unknown>,
    created_at: row.created_at,
  });
  return {
    ...reads,
    ...recipeWrites(db, userId, { kind: "person" }),
    async history(
      name: string,
      cursor?: string,
    ): Promise<StorePage<VersionMetadata>> {
      if (cursor && !/^[1-9][0-9]{0,9}$/.test(cursor))
        throw new StoreError(
          "invalid_cursor",
          "Start this history again with no cursor.",
          400,
        );
      const before = cursor ? Number(cursor) : 2147483648;
      const rows = await db.query<{
        version: number;
        reason: string;
        actor_json: string;
        created_at: string;
      }>(sql`
        SELECT v.version,v.reason,v.actor_json,to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM recipes r JOIN recipe_versions v ON v.user_id=r.user_id AND v.recipe_id=r.id
        WHERE r.user_id=${userId} AND r.name=${name} AND v.version < ${before}::bigint AND ${active}
        ORDER BY v.version DESC LIMIT ${limits.page_size + 1}`);
      const items = rows.slice(0, limits.page_size).map(metadata);
      return {
        items,
        next_cursor:
          rows.length > limits.page_size ? String(items.at(-1)!.version) : null,
      };
    },
    async getVersion(
      name: string,
      number: number,
    ): Promise<(RecipeSnapshot & { metadata: VersionMetadata }) | null> {
      const row = (
        await db.query<
          SnapshotRow & {
            reason: string;
            actor_json: string;
            created_at: string;
          }
        >(sql`
        SELECT r.id,r.name,v.description,v.body,v.archived,v.version,v.reason,v.actor_json,
          to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
        FROM recipes r JOIN recipe_versions v ON v.user_id=r.user_id AND v.recipe_id=r.id
        WHERE r.user_id=${userId} AND r.name=${name} AND v.version=${number} AND ${active}`)
      )[0];
      return row ? { ...snapshot(row), metadata: metadata(row) } : null;
    },
    async downloadRecipes(): Promise<RecipeSnapshot[]> {
      const rows =
        await db.query<SnapshotRow>(sql`SELECT r.id,r.name,v.description,v.body,v.version,v.archived
        FROM recipes r JOIN recipe_versions v ON v.user_id=r.user_id AND v.recipe_id=r.id
        WHERE r.user_id=${userId} AND ${active} AND NOT v.archived
        AND v.version=(SELECT max(h.version) FROM recipe_versions h WHERE h.user_id=r.user_id AND h.recipe_id=r.id) ORDER BY r.name`);
      return rows.map(snapshot);
    },
    async usage() {
      const row = (
        await db.query<{
          retained_bytes: number;
          recipes: number;
          tool_calls: number;
          writes: number;
        }>(sql`
        SELECT u.retained_bytes,(SELECT count(*)::integer FROM recipes r WHERE r.user_id=u.id AND r.name <> 'vibes') AS recipes,
        coalesce(d.tool_calls,0)::integer AS tool_calls,coalesce(d.writes,0)::integer AS writes
        FROM users u LEFT JOIN usage_daily d ON d.user_id=u.id AND d.day_utc=(clock_timestamp() AT TIME ZONE 'UTC')::date
        WHERE u.id=${userId} AND u.status='active'`)
      )[0];
      if (!row)
        throw new StoreError(
          "account_unavailable",
          "This Milton account is unavailable.",
          403,
        );
      return { ...row, limits };
    },
  };
}
export type PersonStore = Awaited<
  ReturnType<typeof personStoreForCurrentRequest>
>;

export async function guardStoreRequest(
  request: Request,
  bindings: StoreBindings,
): Promise<Request | Response> {
  if (recipesSource(bindings) === "bundle") return request;
  const db = database(bindings);
  const limits = await readLimits(db);
  let bounded = request;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limits.request_bytes) {
        await reader.cancel();
        return Response.json({ error: "request_too_large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bounded = new Request(request, { body: body.buffer });
  }

  return bounded;
}
