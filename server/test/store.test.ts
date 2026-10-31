import { memoWrites } from "../src/store/writes";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFailure } from "../src/store/database";
import { StoreError } from "../src/store/errors";
import { localStore } from "./local-store";
import templates from "../generated/templates.json";
import { createStoreMemoTools } from "../src/store/tools";
import type { MemoSnapshot } from "../src/store";
import {
  guardStoreRequest,
  resolveIdentityAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
  personStoreForCurrentRequest,
} from "../src/store";
import {
  importMemos,
  parseImportSource,
  verifyImportedSource,
  loadImportSources,
} from "../scripts/import-memos";

test("Postgres migrations are atomic and contain only the six application tables", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { mkdtemp, cp, appendFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bad = await mkdtemp(join(tmpdir(), "milton-migration-"));
  const pg = new PGlite();
  try {
    await cp(new URL("../drizzle/", import.meta.url), bad, { recursive: true });
    await appendFile(
      join(bad, "0001_store_invariants.sql"),
      "\n--> statement-breakpoint\nSELECT 1/0;\n",
    );
    await expect(
      migrate(drizzle(pg), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(
      (
        await pg.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    // Rehearse 0002 over populated 0000/0001, then rerun it through the journal.
    await cp(
      new URL("../drizzle/0001_store_invariants.sql", import.meta.url),
      join(bad, "0001_store_invariants.sql"),
    );
    const journalPath = join(bad, "meta/_journal.json");
    const journal = JSON.parse(await Bun.file(journalPath).text()) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.find((entry) => entry.idx === 5)?.tag).toBe(
      "0005_memos_rename",
    );
    await Bun.write(
      journalPath,
      JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx < 2),
      }),
    );
    await migrate(drizzle(pg), { migrationsFolder: bad });
    await pg.exec(`INSERT INTO users (id) VALUES ('m_upgrade'); INSERT INTO recipes (user_id,id,name) VALUES ('m_upgrade','upgrade','sample');
      INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json) VALUES ('m_upgrade','upgrade',1,'Sample.','Original café','Initial','{}');`);
    const before = (await pg.query("SELECT * FROM recipe_versions")).rows;
    const bytes = (await pg.query("SELECT retained_bytes FROM users")).rows;
    const oldRecipeGuard = (
      await pg.query(
        "SELECT pg_get_functiondef('milton_recipe_guard'::regproc) AS definition",
      )
    ).rows;
    const oldBytesGuard = (
      await pg.query(
        "SELECT pg_get_functiondef('milton_version_bytes'::regproc) AS definition",
      )
    ).rows;
    // Keep the existing 0004 rollback proof at its historical schema boundary.
    await Bun.write(
      journalPath,
      JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 4),
      }),
    );
    await migrate(drizzle(pg), { migrationsFolder: bad });
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect((await pg.query("SELECT retained_bytes FROM users")).rows).toEqual(
      bytes,
    );
    await migrate(drizzle(pg), { migrationsFolder: bad });
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 5 }]);
    const guardDefinitions = () =>
      pg.query(
        "SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('milton_recipe_guard','milton_version_guard','milton_version_bytes') ORDER BY proname",
      );
    const upgradedGuards = (await guardDefinitions()).rows;
    await pg.exec(
      await Bun.file(
        new URL(
          "../drizzle/rollback/0004_permanent_vibes.sql",
          import.meta.url,
        ),
      ).text(),
    );
    expect(
      (
        await pg.query(
          "SELECT pg_get_functiondef('milton_recipe_guard'::regproc) AS definition",
        )
      ).rows,
    ).toEqual(oldRecipeGuard);
    expect(
      (
        await pg.query(
          "SELECT pg_get_functiondef('milton_version_bytes'::regproc) AS definition",
        )
      ).rows,
    ).toEqual(oldBytesGuard);
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect((await pg.query("SELECT retained_bytes FROM users")).rows).toEqual(
      bytes,
    );
    await pg.exec(
      "UPDATE store_config SET limits_json=limits_json || '{\"recipes\":1}'::jsonb",
    );
    await expect(
      pg.query(
        "INSERT INTO recipes (user_id,id,name) VALUES ('m_upgrade','vibes','vibes')",
      ),
    ).rejects.toThrow("recipe_count_limit");
    await pg.exec(
      "BEGIN;\n" +
        (await Bun.file(
          new URL("../drizzle/0004_permanent_vibes.sql", import.meta.url),
        ).text()) +
        "\nCOMMIT;",
    );
    expect((await guardDefinitions()).rows).toEqual(upgradedGuards);
    await pg.query(
      "INSERT INTO recipes (user_id,id,name) VALUES ('m_upgrade','vibes','vibes')",
    );
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect((await pg.query("SELECT retained_bytes FROM users")).rows).toEqual(
      bytes,
    );
    expect(
      (
        await pg.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename),
    ).toEqual([
      "identities",
      "recipe_versions",
      "recipes",
      "store_config",
      "usage_daily",
      "users",
    ]);

    // Rename real, populated 0004 data, including text that must never be replaced.
    await pg.exec(`
      UPDATE store_config SET signup_mode='allowlist',
        allowed_identities_json='[{"provider":"neon","subject":"upgrade-alpha"}]',
        limits_json=limits_json || '{"recipes":7,"daily_writes":23,"extra_setting":"keep"}';
      INSERT INTO users(id) VALUES ('m_second');
      INSERT INTO identities(provider,subject,user_id) VALUES
        ('neon','upgrade-alpha','m_upgrade'),('neon','upgrade-beta','m_second');
      INSERT INTO usage_daily(user_id,day_utc,tool_calls,writes) VALUES
        ('m_upgrade','2026-10-30',17,3),('m_second','2026-10-30',9,2);
      INSERT INTO recipes(user_id,id,name) VALUES ('m_second','second','recipe-notes');
      INSERT INTO recipe_versions(user_id,recipe_id,version,description,body,archived,reason,actor_json,details_json,created_at) VALUES
        ('m_upgrade','upgrade',2,'Recipe café.',E'Keep recipe text.\\r\\nCafé',true,'Archived recipe','{"kind":"system","id":"recipe-import"}','{"kind":"import","format":{"prefix":"---\\r\\nname: sample\\r\\n---\\r\\n"}}','2026-10-29T12:34:56.123456Z'),
        ('m_upgrade','vibes',1,'Vibes.',E'Legacy vibes\\r\\n',true,'Legacy archive','{"kind":"assistant","issuer":"https://auth.example","client_id":"recipe-client"}','{}','2026-10-29T13:00:00.654321Z'),
        ('m_second','second',1,'Other recipe.','Other café','false','Created recipe','{"kind":"person"}','{}','2026-10-29T14:00:00.123456Z');
    `);
    const capture = async (renamed: boolean) => {
      const rows = async (table: string, order: string) =>
        (
          await pg.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${order}`,
          )
        ).rows;
      const config = (
        await pg.query<{ value: Record<string, unknown> }>(
          "SELECT to_jsonb(c) AS value FROM store_config c",
        )
      ).rows[0]!.value;
      const limits = config.limits_json as Record<string, unknown>;
      if (!renamed) {
        limits.memos = limits.recipes;
        delete limits.recipes;
      }
      return {
        config,
        users: await rows("users", "id"),
        identities: await rows("identities", "provider,subject"),
        usage: await rows("usage_daily", "user_id,day_utc"),
        memos: await rows(renamed ? "memos" : "recipes", "user_id,id"),
        versions: (
          await pg.query(`SELECT
          to_jsonb(v) - '${renamed ? "memo_id" : "recipe_id"}' ||
          jsonb_build_object('memo_id',v.${renamed ? "memo_id" : "recipe_id"}) AS row
          FROM ${renamed ? "memo_versions" : "recipe_versions"} v
          ORDER BY user_id,${renamed ? "memo_id" : "recipe_id"},version`)
        ).rows,
      };
    };
    const catalog = async () => ({
      constraints: (
        await pg.query(
          "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname",
        )
      ).rows,
      indexes: (
        await pg.query(
          "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname",
        )
      ).rows,
      triggers: (
        await pg.query(
          "SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
        )
      ).rows,
      functions: (
        await pg.query(
          "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'milton_%' ORDER BY proname",
        )
      ).rows,
      defaults: (
        await pg.query(
          "SELECT table_name,column_name,column_default,generation_expression FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
        )
      ).rows,
    });
    const original = await capture(false);
    const originalCatalog = await catalog();
    const originalJournal = (
      await pg.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
    ).rows;
    const forward = await Bun.file(
      new URL("../drizzle/0005_memos_rename.sql", import.meta.url),
    ).text();
    await Bun.write(journalPath, JSON.stringify(journal));
    await appendFile(
      join(bad, "0005_memos_rename.sql"),
      "\n--> statement-breakpoint\nSELECT 1/0;\n",
    );
    await expect(
      migrate(drizzle(pg), { migrationsFolder: bad }),
    ).rejects.toMatchObject({ cause: { code: "22012" } });
    expect(await capture(false)).toEqual(original);
    expect(await catalog()).toEqual(originalCatalog);
    expect(
      (await pg.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id"))
        .rows,
    ).toEqual(originalJournal);
    await Bun.write(join(bad, "0005_memos_rename.sql"), forward);
    await migrate(drizzle(pg), { migrationsFolder: bad });
    expect(await capture(true)).toEqual(original);
    const renamedCatalog = await catalog();
    expect(JSON.stringify(renamedCatalog)).not.toMatch(/recipe/i);
    expect(
      (
        await pg.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows,
    ).toEqual([
      { tablename: "identities" },
      { tablename: "memo_versions" },
      { tablename: "memos" },
      { tablename: "store_config" },
      { tablename: "usage_daily" },
      { tablename: "users" },
    ]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
    await migrate(drizzle(pg), { migrationsFolder: bad });
    expect(await capture(true)).toEqual(original);

    // Recovery and a new write after forward must survive the inverse migration.
    await pg.exec(`
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
        SELECT user_id,memo_id,2,description,body,false,'Restored vibes','{"kind":"system"}','{"kind":"restore","source_version":1}'
        FROM memo_versions WHERE user_id='m_upgrade' AND memo_id='vibes' AND version=1;
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,reason,actor_json,details_json)
        VALUES ('m_second','second',2,'New memo.',E'After rename\\r\\nCafé','Import existing memo','{"kind":"system","id":"memo-import"}','{"kind":"import"}');
    `);
    await pg.exec(`
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
        SELECT user_id,memo_id,3,description,body,false,'Restored TPS Report from version 1','{"kind":"person"}','{"kind":"revert","source_version":1}'
        FROM memo_versions WHERE user_id='m_upgrade' AND memo_id='vibes' AND version=1;
      INSERT INTO memo_versions(user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
        SELECT user_id,memo_id,3,description,body,archived,'Reverted to version 1','{"kind":"person"}','{"kind":"revert","source_version":1}'
        FROM memo_versions WHERE user_id='m_second' AND memo_id='second' AND version=1;
    `);
    const afterWrite = await capture(true);
    expect(
      (
        await pg.query(
          "SELECT u.id FROM users u WHERE retained_bytes <> (SELECT coalesce(sum(payload_bytes),0) FROM memo_versions v WHERE v.user_id=u.id)",
        )
      ).rows,
    ).toEqual([]);
    await pg.exec(
      await Bun.file(
        new URL("../drizzle/rollback/0005_memos_rename.sql", import.meta.url),
      ).text(),
    );
    expect(await capture(false)).toEqual(afterWrite);
    expect(await catalog()).toEqual(originalCatalog);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
    // The retained journal skips 0005; explicit re-forward is required.
    await migrate(drizzle(pg), { migrationsFolder: bad });
    expect(await capture(false)).toEqual(afterWrite);
    await pg.exec("BEGIN;\n" + forward + "\nCOMMIT;");
    expect(await capture(true)).toEqual(afterWrite);
    expect(await catalog()).toEqual(renamedCatalog);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
  } finally {
    await pg.close();
    await rm(bad, { recursive: true, force: true });
  }
}, 30000);

test("Postgres accounts per user for immutable contiguous history and plain deletion", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users (id) VALUES ('m_first'),('m_second');
      INSERT INTO memos (user_id,id,name) VALUES ('m_first','same-id','sample'),('m_second','same-id','sample');
      INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES ('m_first','same-id',1,'Sample.','hello','seed','{}'),('m_second','same-id',1,'Sample.','hello','seed','{}');`);
    expect(
      (await local.pg.query("SELECT id,retained_bytes FROM users ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "m_first", retained_bytes: 20 },
      { id: "m_second", retained_bytes: 20 },
    ]);
    await expect(
      local.pg.query("UPDATE memo_versions SET body='changed'"),
    ).rejects.toThrow("memo_version_is_immutable");
    await expect(
      local.pg.query(
        "INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json) VALUES ('m_first','same-id',3,'Sample.','hello','seed','{}')",
      ),
    ).rejects.toThrow("memo_version_conflict");
    await expect(
      local.pg.query("UPDATE users SET id='other' WHERE id='m_first'"),
    ).rejects.toThrow("user_id_is_immutable");
    await local.pg.query(
      "DELETE FROM memos WHERE user_id='m_first' AND id='same-id'",
    );
    expect(
      (await local.pg.query("SELECT id,retained_bytes FROM users ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "m_first", retained_bytes: 0 },
      { id: "m_second", retained_bytes: 20 },
    ]);
    await local.pg.query("DELETE FROM users WHERE id='m_second'");
    expect(
      (await local.pg.query("SELECT count(*)::integer AS n FROM memo_versions"))
        .rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres enforces separate UTF-8 field and memo caps and counts recovery bytes", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":1}'::jsonb; INSERT INTO users (id) VALUES ('m_caps');`,
    );
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','memo',$1)",
      ["a".repeat(64)],
    );
    const append = (
      version: number,
      description: string,
      body: string,
      reason: string,
      kind = "seed",
    ) =>
      local.pg.query(
        "INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json) VALUES ('m_caps','memo',$1,$2,$3,$4,'{}',$5)",
        [version, description, body, reason, JSON.stringify({ kind })],
      );
    await append(1, "é".repeat(250), "é".repeat(16384), "x".repeat(500));
    // Vibes remains available even when the ordinary memo allowance is full.
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','vibes','vibes')",
    );
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 33785 }]);
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','too-long',$1)",
        ["a".repeat(65)],
      ),
    ).rejects.toThrow("memo_name_limit");
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','second','second')",
      ),
    ).rejects.toThrow("memo_count_limit");
    await expect(append(2, "é".repeat(250) + "x", "", "")).rejects.toThrow(
      "memo_description_limit",
    );
    await expect(append(2, "ok", "é".repeat(16384) + "x", "")).rejects.toThrow(
      "memo_body_limit",
    );
    await expect(append(2, "ok", "", "x".repeat(501))).rejects.toThrow(
      "memo_reason_limit",
    );
    await local.pg.query(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":33785}'::jsonb`,
    );
    await expect(append(2, "ok", "", "")).rejects.toThrow("memo_history_limit");
    expect(
      (await local.pg.query("SELECT count(*)::integer AS n FROM memo_versions"))
        .rows,
    ).toEqual([{ n: 1 }]);
    await expect(append(2, "ok", "", "", "revert")).rejects.toThrow(
      "memo_recovery_invalid",
    );
    const forgedRecovery = await local.pg
      .query(
        `INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json,details_json)
      VALUES ('m_caps','memo',2,'ok','arbitrary recovery','','{"kind":"person"}','{"kind":"revert","source_version":1}')`,
      )
      .catch(databaseFailure);
    expect(forgedRecovery).toMatchObject({
      code: "memo_recovery_invalid",
      status: 422,
    });
    await local.pg
      .query(`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,memo_id,2,description,body,archived,'','{"kind":"person"}','{"kind":"revert","source_version":1}' FROM memo_versions WHERE version=1`);
    expect(
      (
        await local.pg.query<{ retained_bytes: number }>(
          "SELECT retained_bytes FROM users",
        )
      ).rows[0]!.retained_bytes,
    ).toBeGreaterThan(33785);
    await local.pg.query("DELETE FROM memo_versions WHERE version=2");
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 33785 }]);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":2}'::jsonb`,
    );
    await local.pg.query(
      "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','second','second')",
    );
    await expect(
      local.pg.query(
        "INSERT INTO memos (user_id,id,name) VALUES ('m_caps','third','third')",
      ),
    ).rejects.toThrow("memo_count_limit");
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres version conflicts and history-cap import refusals return typed errors", async () => {
  const local = await localStore();
  const userId = "m_00000000-0000-4000-8000-000000000001";
  try {
    await local.db.query(sql`INSERT INTO users (id) VALUES (${userId})`);
    await local.db.query(
      sql`INSERT INTO memos (user_id,id,name) VALUES (${userId},'memo','sample')`,
    );
    await local.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${userId},'memo',1,'Sample.','hello','seed','{}')`);
    const conflict = await local.db
      .query(
        sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
      VALUES (${userId},'memo',1,'Sample.','changed','edit','{}')`,
      )
      .catch(databaseFailure);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1}'::jsonb`,
    );
    const source = parseImportSource(
      "sample",
      "---\nname: sample\ndescription: An import fixture.\n---\n# Imported\n",
    );
    const history = await importMemos(
      local.db,
      userId,
      [source],
      new Map([[source.name, 1]]),
    ).catch(databaseFailure);
    expect(conflict).toBeInstanceOf(StoreError);
    expect(history).toBeInstanceOf(StoreError);
    expect([conflict, history]).toMatchObject([
      {
        code: "memo_version_conflict",
        message: "The memo version conflicts with the current memo.",
        status: 409,
      },
      {
        code: "memo_history_limit",
        message: "The memo history limit has been reached.",
        status: 422,
      },
    ]);
    expect(
      await local.db.query(
        sql`SELECT version,body FROM memo_versions WHERE user_id=${userId}`,
      ),
    ).toEqual([{ version: 1, body: "hello" }]);
    expect(
      await local.db.query(
        sql`SELECT retained_bytes FROM users WHERE id=${userId}`,
      ),
    ).toEqual([{ retained_bytes: 20 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("store ingress bounds streamed bodies before parsing and preserves typed failures", async () => {
  const local = await localStore();
  try {
    const bindings = { ...local.env, MEMOS_SOURCE: "store" };
    const refused = await guardStoreRequest(
      new Request("http://localhost:8787/mcp", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(65537));
            controller.close();
          },
        }),
      }),
      bindings,
    );
    expect(refused).toBeInstanceOf(Response);
    if (!(refused instanceof Response))
      throw new Error("Expected body refusal");
    expect(refused.status).toBe(413);
    expect(
      await guardStoreRequest(
        new Request("http://localhost:8787/register", {
          method: "POST",
          body: "{}",
        }),
        bindings,
      ),
    ).toBeInstanceOf(Request);
    const unavailable = {
      ...bindings,
      storeDatabase: new Proxy(local.db, {
        get(target, key) {
          if (key === "query" || key === "transaction")
            return async () => {
              throw new Error("fixture database failure");
            };
          return Reflect.get(target, key);
        },
      }),
    };
    await expect(
      guardStoreRequest(
        new Request("http://localhost:8787/register", {
          method: "POST",
          body: "{}",
        }),
        unavailable,
      ),
    ).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
    await expect(
      resolveIdentityAccount(unavailable, {
        provider: "neon",
        subject: "3004",
      }),
    ).rejects.toMatchObject({ code: "store_unavailable", status: 503 });
  } finally {
    await local.dispose();
  }
}, 30000);

test("identity lookup never admits or seeds an MCP caller", async () => {
  const local = await localStore();
  const identity = { provider: "neon", subject: "lookup-fixture" };
  try {
    await expect(
      resolveIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "admission_refused", status: 403 });
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    await expect(
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 0 }]);
    // Preserve concurrent admission, repeatable seeding, and failed-admission rollback.
    const same = await Promise.all([
      resolveIdentityAccount(local.env, identity),
      resolveIdentityAccount(local.env, identity),
    ]);
    const admitted = same[0]!;
    expect(same[1]!.miltonUserId).toBe(admitted.miltonUserId);
    expect((await lookupIdentityAccount(local.env, identity)).userId).toBe(
      admitted.miltonUserId,
    );
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await local.db.query(
        sql`SELECT r.name,v.body,u.templates_revision FROM users u JOIN memos r ON r.user_id=u.id JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id WHERE u.id=${admitted.miltonUserId}`,
      ),
    ).toEqual([{ name: "vibes", body: "", templates_revision: 2 }]);
    const concurrent = await Promise.allSettled([
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "second-fixture",
      }),
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "third-fixture",
      }),
    ]);
    expect(concurrent.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await local.db.query(sql`UPDATE store_config SET signup_mode='closed'`);
    expect(
      (await resolveIdentityAccount(local.env, identity)).miltonUserId,
    ).toBe(admitted.miltonUserId);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 3 }]);
    await local.db.query(
      sql`UPDATE store_config SET signup_mode='open', limits_json=limits_json || '{"description_bytes":1}'::jsonb`,
    );
    await expect(
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "failed-seed",
      }),
    ).rejects.toMatchObject({ code: "memo_description_limit", status: 422 });
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 3 }]);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM identities`),
    ).toEqual([{ n: 3 }]);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id)`,
      ),
    ).toEqual([{ n: 0 }]);
    await local.db.query(
      sql`UPDATE users SET status='deleting' WHERE id=${admitted.miltonUserId}`,
    );
    await expect(
      lookupIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    await expect(
      resolveIdentityAccount(local.env, identity),
    ).rejects.toMatchObject({ code: "account_unavailable", status: 403 });
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 3 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("unfinished initialization creates only empty TPS at retained-history capacity", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`
      INSERT INTO users (id) VALUES ('m_unfinished');
      INSERT INTO identities (provider,subject,user_id) VALUES ('neon','unfinished','m_unfinished');
      INSERT INTO memos (user_id,id,name) VALUES ('m_unfinished','ordinary','email-voice');
      INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json)
        VALUES ('m_unfinished','ordinary',1,'Keep exact.',E'café\\r\\n','Original reason','{"kind":"assistant","client_id":"fixture"}');
      UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}',
        to_jsonb((SELECT retained_bytes FROM users WHERE id='m_unfinished')));
    `);
    const before = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE memo_id='ordinary'`,
    );
    const identity = { provider: "neon", subject: "unfinished" };
    expect(
      (await resolveIdentityAccount(local.env, identity)).miltonUserId,
    ).toBe("m_unfinished");
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE memo_id='ordinary'`,
      ),
    ).toEqual(before);
    expect(
      await local.db.query(
        sql`SELECT name,version,body,reason,actor_json,details_json FROM memos r JOIN memo_versions v ON v.user_id=r.user_id AND v.memo_id=r.id WHERE r.name='vibes'`,
      ),
    ).toEqual([
      {
        name: "vibes",
        version: 1,
        body: "",
        reason: "Created TPS Report",
        actor_json: '{"kind":"system"}',
        details_json: '{"kind":"create"}',
      },
    ]);
    expect(
      await local.db.query(
        sql`SELECT templates_revision,retained_bytes=(SELECT sum(payload_bytes) FROM memo_versions WHERE user_id=u.id) AS accounted FROM users u WHERE id='m_unfinished'`,
      ),
    ).toEqual([{ templates_revision: 2, accounted: true }]);
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT count(*)::integer AS n FROM memo_versions`,
      ),
    ).toEqual([{ n: 2 }]);
    await local.db.query(
      sql`UPDATE users SET templates_revision=0 WHERE id='m_unfinished'`,
    );
    await local.db.query(
      sql`UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}','67108864')`,
    );
    await local.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,memo_id,2,description,body,true,'Legacy archive','{}','{}' FROM memo_versions WHERE user_id='m_unfinished' AND memo_id=(SELECT id FROM memos WHERE user_id='m_unfinished' AND name='vibes') AND version=1`);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=jsonb_set(limits_json,'{history_bytes}','1')`,
    );
    const legacy = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v WHERE version<3 ORDER BY memo_id,version`,
      ),
    ).toEqual(legacy);
    expect(
      await local.db.query(
        sql`SELECT version,body,archived,reason,details_json FROM memo_versions WHERE version=3`,
      ),
    ).toEqual([
      {
        version: 3,
        body: "",
        archived: false,
        reason: "Restored TPS Report",
        details_json: '{"kind":"restore","source_version":2}',
      },
    ]);
    await local.db.query(
      sql`UPDATE users SET templates_revision=0 WHERE id='m_unfinished'`,
    );
    const active = await local.db.query(
      sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT row_to_json(v) AS row FROM memo_versions v ORDER BY memo_id,version`,
      ),
    ).toEqual(active);
    await local.db.query(
      sql`UPDATE users SET templates_revision=1 WHERE id='m_unfinished'`,
    );
    await resolveIdentityAccount(local.env, identity);
    expect(
      await local.db.query(
        sql`SELECT templates_revision FROM users WHERE id='m_unfinished'`,
      ),
    ).toEqual([{ templates_revision: 1 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("one expected-version conflict rolls back every imported memo and byte increment", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const account = await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "fixture-import",
    });
    if (!account) throw new Error("Fixture admission failed");
    await importMemos(
      local.db,
      account.miltonUserId,
      [
        parseImportSource(
          "email-voice",
          "---\nname: email-voice\ndescription: Existing ordinary fixture.\n---\n# Existing\n",
        ),
      ],
      new Map([["email-voice", 0]]),
    );
    const sources = ["email-voice", "vibes"].map((name) =>
      parseImportSource(
        name,
        `---\nname: ${name}\ndescription: An atomic import fixture.\n---\n# Imported\n`,
      ),
    );
    const before = await local.db.query(
      sql`SELECT retained_bytes FROM users WHERE id=${account.miltonUserId}`,
    );
    await expect(
      importMemos(
        local.db,
        account.miltonUserId,
        sources,
        new Map([
          ["email-voice", 1],
          ["vibes", 999],
        ]),
      ),
    ).rejects.toThrow("expected version conflicts");
    expect(
      await local.db.query(
        sql`SELECT max(version) AS n FROM memo_versions WHERE user_id=${account.miltonUserId}`,
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await local.db.query(
        sql`SELECT retained_bytes FROM users WHERE id=${account.miltonUserId}`,
      ),
    ).toEqual(before);
  } finally {
    await local.dispose();
  }
}, 30000);

test("import verifies exact bytes, conflicts on retry and permits recreation after deletion", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const account = await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "opaque-better-auth-user",
    });
    await importMemos(
      local.db,
      account.miltonUserId,
      [
        parseImportSource(
          "email-voice",
          "---\nname: email-voice\ndescription: Existing ordinary fixture.\n---\n# Existing\n",
        ),
      ],
      new Map([["email-voice", 0]]),
    );
    const source = parseImportSource(
      "email-voice",
      "---\r\nname: email-voice\r\ndescription: An imported fixture.\r\n---\r\n# Fixture\r\n\r\nKeep café exact.\r\n",
    );
    const created = parseImportSource(
      "new-fixture",
      "---\nname: new-fixture\ndescription: A new fixture.\n---\n# New\n",
    );
    await expect(
      importMemos(local.db, account.miltonUserId, [source], new Map()),
    ).rejects.toThrow("expected version");
    const expected = new Map([
      [source.name, 1],
      [created.name, 0],
    ]);
    const first = await importMemos(
      local.db,
      account.miltonUserId,
      [source, created],
      expected,
    );
    expect(first.map((row) => [row.name, row.version])).toEqual([
      ["email-voice", 2],
      ["new-fixture", 1],
    ]);
    await expect(
      importMemos(local.db, account.miltonUserId, [source, created], expected),
    ).rejects.toThrow("conflicts");
    await expect(
      importMemos(
        local.db,
        account.miltonUserId,
        [created],
        new Map([[created.name, 0]]),
      ),
    ).rejects.toThrow("conflicts");
    expect(() =>
      verifyImportedSource(source, {
        ...source,
        description: "Wrong stored description.",
      }),
    ).toThrow("fields");
    await local.db.query(
      sql`DELETE FROM memos WHERE user_id=${account.miltonUserId} AND name=${created.name}`,
    );
    expect(
      (
        await importMemos(local.db, account.miltonUserId, [created], new Map())
      ).map((row) => row.version),
    ).toEqual([1]);
    expect(
      (
        await loadImportSources(new URL("./fixtures/memos/", import.meta.url))
      ).map((row) => row.name),
    ).toEqual(["sample"]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("get_tps_report preserves snapshots, recognizes unset bodies, and repairs missing vibes", async () => {
  const local = await localStore();
  try {
    const template = templates.find((memo) => memo.name === "vibes");
    if (!template) throw new Error("The generated vibes template is missing");
    expect(template.body).toBe("");
    await local.pg.exec("UPDATE store_config SET signup_mode='open'");
    const identity = { provider: "neon", subject: "vibes-reader" };
    await resolveIdentityAccount(local.env, identity);
    const auth = await lookupIdentityAccount(local.env, identity);
    const store = await storeForCurrentRequest(local.env, auth, {
      issuer: "https://auth.example",
      clientId: "vibes-client",
    });
    const person = await personStoreForCurrentRequest(local.env, auth);
    const tools = createStoreMemoTools(store);
    const check = async (memo: MemoSnapshot, isTemplate: boolean) => {
      const result = await tools.get_tps_report();
      expect(result.isError).not.toBe(true);
      const { name: _name, ...publicMemo } = memo;
      expect(JSON.parse(result.content[0].text)).toEqual({
        title: "TPS Report",
        ...publicMemo,
        is_template: isTemplate,
      });
      expect(await store.getMemo("vibes")).toEqual(memo);
      expect(
        JSON.parse((await tools.get_memo("vibes")).content[0].text),
      ).toMatchObject({ error: "tps_report_required" });
    };
    let current = (await store.getMemo("vibes"))!;
    expect(current.version).toMatch(/^vibes@1·/);
    await check(current, true);
    current = await store.updateTpsReport({
      text: current.text,
      description: "A changed description.",
      reason: "Description only",
      expected_version: current.version,
    });
    await check(current, true);
    for (const [text, isTemplate] of [
      [` \t\r\n${template.body.replace(/\n/g, "\r\n")}\r\n\t `, true],
      ["", true],
      [" \r\n# Working style\r\n\t", true],
      [" \r\n\t", true],
      ["# Working style\n\nUse short replies.\r\n", false],
      ["# Working  style", false],
      ["# My working style", false],
      ["# Working style\n<!-- A preference -->", false],
    ] as const) {
      current = await store.updateTpsReport({
        text,
        reason: "Style preference",
        expected_version: current.version,
      });
      await check(current, isTemplate);
    }
    current = await person.revertMemo({
      name: "vibes",
      source_version: 1,
      expected_version: current.version,
    });
    expect(current.version).not.toMatch(/^vibes@1·/);
    await check(current, true);
    expect((await person.history("vibes")).items[0]?.actor).toEqual({
      kind: "person",
    });
    const refusal = {
      code: "tps_report_required",
      status: 422,
      message:
        "Use the dedicated TPS Report tools. TPS Report cannot be archived or deleted.",
    };
    await expect(
      store.archiveMemo({
        name: "vibes",
        reason: "Archive",
        expected_version: current.version,
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      memoWrites(local.db, auth.userId, { kind: "person" }).deleteMemo({
        name: "vibes",
        confirmation: "vibes",
        expected_version: current.version,
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      store.createMemo({
        name: "vibes",
        description: "Duplicate",
        text: "Duplicate",
      }),
    ).rejects.toMatchObject({ code: "tps_report_required" });
    // Preserve an archived snapshot from before vibes became permanent.
    await local.db.query(sql`INSERT INTO memo_versions
      (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT v.user_id,v.memo_id,v.version+1,v.description,v.body,true,'Legacy archive','{}','{}'
      FROM memo_versions v JOIN memos r ON r.user_id=v.user_id AND r.id=v.memo_id
      WHERE r.user_id=${auth.userId} AND r.name='vibes' AND v.version=(SELECT max(version) FROM memo_versions WHERE user_id=r.user_id AND memo_id=r.id)`);
    const legacy = (await person.history("vibes")).items[0]!;
    const restored = await store.getTpsReport();
    expect(restored).toMatchObject({
      text: current.text,
      description: current.description,
      archived: false,
    });
    expect(restored!.version).not.toBe(current.version);
    await check(restored!, true);
    expect((await person.history("vibes")).items[0]).toMatchObject({
      reason: "Restored TPS Report",
      actor: { kind: "system" },
    });
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1,"daily_writes":1}'::jsonb`,
    );
    const reverted = await person.revertMemo({
      name: "vibes",
      source_version: legacy.version,
      expected_version: restored!.version,
    });
    expect(reverted.archived).toBe(false);
    // Simulate an account whose vibes was deleted before it became permanent.
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"memos":1}'::jsonb`,
    );
    await local.db.query(
      sql`DELETE FROM memos WHERE user_id=${auth.userId} AND name='vibes'`,
    );
    const [repaired, repeated] = await Promise.all([
      store.getTpsReport(),
      store.getTpsReport(),
    ]);
    expect(repeated).toEqual(repaired);
    expect(repaired).toMatchObject({
      text: "",
      archived: false,
      version: expect.stringMatching(/^vibes@1·/),
    });
    await check(repaired!, true);
    expect((await person.history("vibes")).items).toMatchObject([
      { version: 1, reason: "Created TPS Report", actor: { kind: "system" } },
    ]);
    expect((await person.history("vibes")).items).toHaveLength(1);
    expect((await person.usage()).memos).toBe(0);
  } finally {
    await local.dispose();
  }
}, 30000);

test("writes commit once, conflict with the current tag, and fence recreated names", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("UPDATE store_config SET signup_mode='open'");
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "writer",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: "neon",
      subject: "writer",
    });
    const store = await storeForCurrentRequest(local.env, auth, {
      issuer: "https://auth.example",
      clientId: "exact-client",
    });
    const first = await store.createMemo({
      name: "new",
      description: "A memo.",
      text: "First café\r\n",
    });
    expect(first).toMatchObject({
      name: "new",
      text: "First café\r\n",
      archived: false,
    });
    expect(first.version).toMatch(/^new@1·/);
    const updated = await store.updateMemo({
      name: "new",
      text: "Second",
      reason: "A preference",
      expected_version: first.version,
    });
    expect(updated).toMatchObject({ description: "A memo." });
    expect(updated.version).toMatch(/^new@2·/);
    for (const tag of [
      first.version,
      "new@2·unknown",
      "new@02·unknown",
      "invalid",
    ]) {
      await expect(
        store.updateMemo({
          name: "new",
          text: "Lost",
          reason: "Retry",
          expected_version: tag,
        }),
      ).rejects.toMatchObject({
        code: "memo_version_conflict",
        details: { current: updated },
      });
    }
    await expect(
      store.createMemo({ name: "new", description: "Other", text: "Other" }),
    ).rejects.toMatchObject({ code: "memo_version_conflict" });
    const person = await personStoreForCurrentRequest(local.env, auth);
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "other-writer",
    });
    const otherAuth = await lookupIdentityAccount(local.env, {
      provider: "neon",
      subject: "other-writer",
    });
    const other = await personStoreForCurrentRequest(local.env, otherAuth);
    const otherWriter = await storeForCurrentRequest(local.env, otherAuth, {
      issuer: "https://auth.example",
      clientId: "other",
    });
    const otherMemo = await otherWriter.createMemo({
      name: "new",
      description: "Other tenant.",
      text: "Other tenant body",
    });
    expect((await other.history("new")).items).toHaveLength(1);
    expect(
      (await other.downloadMemos()).find((memo) => memo.name === "new")?.text,
    ).toBe("Other tenant body");
    await expect(
      memoWrites(local.db, auth.userId, { kind: "person" }).deleteMemo({
        name: "new",
        expected_version: otherMemo.version,
        confirmation: "new",
      }),
    ).rejects.toMatchObject({ code: "memo_version_conflict" });
    await memoWrites(local.db, auth.userId, { kind: "person" }).deleteMemo({
      name: "new",
      expected_version: updated.version,
      confirmation: "new",
    });
    expect((await other.getMemo("new"))?.text).toBe("Other tenant body");
    const recreated = await store.createMemo({
      name: "new",
      description: "Recreated",
      text: "New life",
    });
    expect(recreated.version).not.toBe(first.version);
    await expect(
      store.archiveMemo({
        name: "new",
        reason: "Stale",
        expected_version: first.version,
      }),
    ).rejects.toMatchObject({
      code: "memo_version_conflict",
      details: { current: recreated },
    });
    expect((await person.history("new")).items).toMatchObject([
      {
        version: 1,
        actor: {
          kind: "assistant",
          issuer: "https://auth.example",
          client_id: "exact-client",
        },
      },
    ]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("write refusals roll back charges and full caps still allow stored recovery and deletion", async () => {
  const local = await localStore();
  try {
    await local.pg.exec("UPDATE store_config SET signup_mode='open'");
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "caps-writer",
    });
    const auth = await lookupIdentityAccount(local.env, {
      provider: "neon",
      subject: "caps-writer",
    });
    const person = await personStoreForCurrentRequest(local.env, auth);
    const writer = await storeForCurrentRequest(local.env, auth, {
      issuer: "https://auth.example",
      clientId: "caps-writer",
    });
    await local.db.query(
      sql`INSERT INTO memos (user_id,id,name) VALUES (${auth.userId},'retained','retained')`,
    );
    await local.db.query(
      sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,reason,actor_json) VALUES (${auth.userId},'retained',1,'Retained.','Keep exact','Fixture','{}')`,
    );
    const created = await writer.createMemo({
      name: "sample",
      description: "Sample.",
      text: "Original",
    });
    const archived = await person.archiveMemo({
      name: "sample",
      expected_version: created.version,
      reason: "Archive",
    });
    await expect(
      person.archiveMemo({
        name: "sample",
        expected_version: archived.version,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "memo_state_conflict" });
    const unarchived = await person.restoreMemo({
      name: "sample",
      expected_version: archived.version,
    });
    const edited = await writer.updateMemo({
      name: "sample",
      expected_version: unarchived.version,
      reason: "Edit after restore",
      text: "Changed body",
    });
    expect(edited.archived).toBe(false);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1,"daily_writes":4}'::jsonb`,
    );
    await expect(
      writer.updateMemo({
        name: "sample",
        expected_version: edited.version,
        reason: "Too much",
        text: "Fail",
      }),
    ).rejects.toMatchObject({ code: "memo_history_limit" });
    expect((await person.usage()).writes).toBe(3);
    await expect(
      person.archiveMemo({
        name: "sample",
        expected_version: edited.version,
        reason: "Archive at history cap",
      }),
    ).rejects.toMatchObject({ code: "memo_history_limit" });
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"daily_writes":3}'::jsonb`,
    );
    await expect(
      writer.updateMemo({
        name: "sample",
        expected_version: edited.version,
        reason: "Over daily",
        text: "Fail",
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      details: { limit: "writes" },
    });
    await expect(
      person.archiveMemo({
        name: "sample",
        expected_version: edited.version,
        reason: "Archive at daily cap",
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    const archivedRecovery = await person.revertMemo({
      name: "sample",
      expected_version: edited.version,
      source_version: 2,
    });
    expect(archivedRecovery.archived).toBe(true);
    const restored = await person.restoreMemo({
      name: "sample",
      expected_version: archivedRecovery.version,
    });
    expect(restored.text).toBe("Original");
    expect(restored.archived).toBe(false);
    const reverted = await person.revertMemo({
      name: "sample",
      expected_version: restored.version,
      source_version: 1,
    });
    expect(reverted.text).toBe("Original");
    expect((await person.usage()).writes).toBe(3);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"page_size":2}'::jsonb`,
    );
    const paged = await personStoreForCurrentRequest(local.env, auth);
    const history = await paged.history("sample");
    expect(history.items.map((v) => v.version)).toEqual([7, 6]);
    expect(history.next_cursor).toBe("6");
    expect(
      (await paged.history("sample", history.next_cursor!)).items.map(
        (v) => v.version,
      ),
    ).toEqual([5, 4]);
    await expect(
      memoWrites(local.db, auth.userId, { kind: "person" }).deleteMemo({
        name: "sample",
        expected_version: reverted.version,
        confirmation: "wrong",
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    await memoWrites(local.db, auth.userId, { kind: "person" }).deleteMemo({
      name: "sample",
      expected_version: reverted.version,
      confirmation: "sample",
    });
    expect(await person.getMemo("sample")).toBeNull();
    expect((await person.history("sample")).items).toEqual([]);
    expect((await person.downloadMemos()).map((v) => v.name)).not.toContain(
      "sample",
    );
    // Recreate missing vibes even when the remaining history fills the cap.
    await local.db.query(
      sql`DELETE FROM memos WHERE user_id=${auth.userId} AND name='vibes'`,
    );
    const beforeRepair = await person.usage();
    expect(beforeRepair.retained_bytes).toBeGreaterThan(0);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || jsonb_build_object('history_bytes',${beforeRepair.retained_bytes}::bigint)`,
    );
    const repaired = await person.getTpsReport();
    expect(repaired).toMatchObject({
      name: "vibes",
      text: "",
      archived: false,
    });
    expect(repaired.version).toMatch(/^vibes@1·/);
    expect(await person.getTpsReport()).toEqual(repaired);
    expect((await person.history("vibes")).items).toMatchObject([
      { version: 1, reason: "Created TPS Report", actor: { kind: "system" } },
    ]);
    const afterRepair = await person.usage();
    expect(afterRepair.retained_bytes).toBeGreaterThan(
      beforeRepair.retained_bytes,
    );
    expect(afterRepair.writes).toBe(beforeRepair.writes);
  } finally {
    await local.dispose();
  }
}, 30000);
