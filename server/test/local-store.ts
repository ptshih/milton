import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { SQL } from "drizzle-orm";
import type { StoreDatabase } from "../src/store/database";

// Same PostgreSQL schema and transaction rules, no network or environment secrets.
export async function localStore() {
  const pg = new PGlite();
  const orm = drizzle(pg);
  try {
    await migrate(orm, {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
    const db: StoreDatabase = {
      async query<Row extends Record<string, unknown>>(statement: SQL) {
        return (await orm.execute<Row>(statement)).rows as Row[];
      },
      transaction: (work) =>
        orm.transaction((tx) =>
          work({
            async query<Row extends Record<string, unknown>>(statement: SQL) {
              return (await tx.execute<Row>(statement)).rows as Row[];
            },
          }),
        ),
      withConnection: (work) => work(db),
    };
    return {
      pg,
      db,
      env: { storeDatabase: db },
      async dispose() {
        await pg.close();
      },
    };
  } catch (error) {
    await pg.close();
    throw error;
  }
}
