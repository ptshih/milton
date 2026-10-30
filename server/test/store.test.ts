import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFailure } from "../src/store/database";
import { StoreError } from "../src/store/errors";
import { localStore } from "./local-store";
import {
  guardStoreRequest,
  resolveIdentityAccount,
  lookupIdentityAccount,
  storeForCurrentRequest,
  personStoreForCurrentRequest,
} from "../src/store";
import {
  importRecipes,
  parseImportSource,
  verifyImportedSource,
  loadImportSources,
} from "../scripts/import-recipes";

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
      entries: { idx: number }[];
    };
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
    await migrate(drizzle(pg), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect((await pg.query("SELECT retained_bytes FROM users")).rows).toEqual(
      bytes,
    );
    await migrate(drizzle(pg), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
    expect((await pg.query("SELECT * FROM recipe_versions")).rows).toEqual(
      before,
    );
    expect(
      (
        await pg.query(
          "SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual([{ n: 4 }]);
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
  } finally {
    await pg.close();
    await rm(bad, { recursive: true, force: true });
  }
}, 30000);

test("Postgres accounts per user for immutable contiguous history and plain deletion", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(`INSERT INTO users (id) VALUES ('m_first'),('m_second');
      INSERT INTO recipes (user_id,id,name) VALUES ('m_first','same-id','sample'),('m_second','same-id','sample');
      INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json)
      VALUES ('m_first','same-id',1,'Sample.','hello','seed','{}'),('m_second','same-id',1,'Sample.','hello','seed','{}');`);
    expect(
      (await local.pg.query("SELECT id,retained_bytes FROM users ORDER BY id"))
        .rows,
    ).toEqual([
      { id: "m_first", retained_bytes: 20 },
      { id: "m_second", retained_bytes: 20 },
    ]);
    await expect(
      local.pg.query("UPDATE recipe_versions SET body='changed'"),
    ).rejects.toThrow("recipe_version_is_immutable");
    await expect(
      local.pg.query(
        "INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json) VALUES ('m_first','same-id',3,'Sample.','hello','seed','{}')",
      ),
    ).rejects.toThrow("recipe_version_conflict");
    await expect(
      local.pg.query("UPDATE users SET id='other' WHERE id='m_first'"),
    ).rejects.toThrow("user_id_is_immutable");
    await local.pg.query(
      "DELETE FROM recipes WHERE user_id='m_first' AND id='same-id'",
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
      (
        await local.pg.query(
          "SELECT count(*)::integer AS n FROM recipe_versions",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("Postgres enforces separate UTF-8 field and recipe caps and counts recovery bytes", async () => {
  const local = await localStore();
  try {
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"recipes":1}'::jsonb; INSERT INTO users (id) VALUES ('m_caps');`,
    );
    await local.pg.query(
      "INSERT INTO recipes (user_id,id,name) VALUES ('m_caps','recipe',$1)",
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
        "INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json,details_json) VALUES ('m_caps','recipe',$1,$2,$3,$4,'{}',$5)",
        [version, description, body, reason, JSON.stringify({ kind })],
      );
    await append(1, "é".repeat(250), "é".repeat(16384), "x".repeat(500));
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 33785 }]);
    await expect(
      local.pg.query(
        "INSERT INTO recipes (user_id,id,name) VALUES ('m_caps','too-long',$1)",
        ["a".repeat(65)],
      ),
    ).rejects.toThrow("recipe_name_limit");
    await expect(
      local.pg.query(
        "INSERT INTO recipes (user_id,id,name) VALUES ('m_caps','second','second')",
      ),
    ).rejects.toThrow("recipe_count_limit");
    await expect(append(2, "é".repeat(250) + "x", "", "")).rejects.toThrow(
      "recipe_description_limit",
    );
    await expect(append(2, "ok", "é".repeat(16384) + "x", "")).rejects.toThrow(
      "recipe_body_limit",
    );
    await expect(append(2, "ok", "", "x".repeat(501))).rejects.toThrow(
      "recipe_reason_limit",
    );
    await local.pg.query(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":33785}'::jsonb`,
    );
    await expect(append(2, "ok", "", "")).rejects.toThrow(
      "recipe_history_limit",
    );
    expect(
      (
        await local.pg.query(
          "SELECT count(*)::integer AS n FROM recipe_versions",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    await expect(append(2, "ok", "", "", "revert")).rejects.toThrow(
      "recipe_recovery_invalid",
    );
    const forgedRecovery = await local.pg
      .query(
        `INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json,details_json)
      VALUES ('m_caps','recipe',2,'ok','arbitrary recovery','','{"kind":"person"}','{"kind":"revert","source_version":1}')`,
      )
      .catch(databaseFailure);
    expect(forgedRecovery).toMatchObject({
      code: "recipe_recovery_invalid",
      status: 422,
    });
    await local.pg
      .query(`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,recipe_id,2,description,body,archived,'','{"kind":"person"}','{"kind":"revert","source_version":1}' FROM recipe_versions WHERE version=1`);
    expect(
      (
        await local.pg.query<{ retained_bytes: number }>(
          "SELECT retained_bytes FROM users",
        )
      ).rows[0]!.retained_bytes,
    ).toBeGreaterThan(33785);
    await local.pg.query("DELETE FROM recipe_versions WHERE version=2");
    expect(
      (await local.pg.query("SELECT retained_bytes FROM users")).rows,
    ).toEqual([{ retained_bytes: 33785 }]);
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
      sql`INSERT INTO recipes (user_id,id,name) VALUES (${userId},'recipe','sample')`,
    );
    await local.db
      .query(sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json)
      VALUES (${userId},'recipe',1,'Sample.','hello','seed','{}')`);
    const conflict = await local.db
      .query(
        sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,reason,actor_json)
      VALUES (${userId},'recipe',1,'Sample.','changed','edit','{}')`,
      )
      .catch(databaseFailure);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1}'::jsonb`,
    );
    const source = parseImportSource(
      "sample",
      "---\nname: sample\ndescription: An import fixture.\n---\n# Imported\n",
    );
    const history = await importRecipes(
      local.db,
      userId,
      [source],
      new Map([[source.name, 1]]),
    ).catch(databaseFailure);
    expect(conflict).toBeInstanceOf(StoreError);
    expect(history).toBeInstanceOf(StoreError);
    expect([conflict, history]).toMatchObject([
      {
        code: "recipe_version_conflict",
        message: "The recipe version conflicts with the current recipe.",
        status: 409,
      },
      {
        code: "recipe_history_limit",
        message: "The recipe history limit has been reached.",
        status: 422,
      },
    ]);
    expect(
      await local.db.query(
        sql`SELECT version,body FROM recipe_versions WHERE user_id=${userId}`,
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
    const bindings = { ...local.env, RECIPES_SOURCE: "store" };
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
        sql`SELECT count(*)::integer AS n FROM recipe_versions`,
      ),
    ).toEqual([{ n: 2 }]);
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
        sql`SELECT count(*)::integer AS n FROM recipe_versions`,
      ),
    ).toEqual([{ n: 6 }]);
    await local.db.query(
      sql`UPDATE store_config SET signup_mode='open', limits_json=limits_json || '{"body_bytes":1}'::jsonb`,
    );
    await expect(
      resolveIdentityAccount(local.env, {
        provider: "neon",
        subject: "failed-seed",
      }),
    ).rejects.toMatchObject({ code: "recipe_body_limit", status: 422 });
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
        sql`SELECT count(*)::integer AS n FROM recipe_versions`,
      ),
    ).toEqual([{ n: 6 }]);
  } finally {
    await local.dispose();
  }
}, 30000);

test("one expected-version conflict rolls back every imported recipe and byte increment", async () => {
  const local = await localStore();
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const account = await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "fixture-import",
    });
    if (!account) throw new Error("Fixture admission failed");
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
      importRecipes(
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
        sql`SELECT max(version) AS n FROM recipe_versions WHERE user_id=${account.miltonUserId}`,
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
    const source = parseImportSource(
      "email-voice",
      "---\r\nname: email-voice\r\ndescription: An imported fixture.\r\n---\r\n# Fixture\r\n\r\nKeep café exact.\r\n",
    );
    const created = parseImportSource(
      "new-fixture",
      "---\nname: new-fixture\ndescription: A new fixture.\n---\n# New\n",
    );
    await expect(
      importRecipes(local.db, account.miltonUserId, [source], new Map()),
    ).rejects.toThrow("expected version");
    const expected = new Map([
      [source.name, 1],
      [created.name, 0],
    ]);
    const first = await importRecipes(
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
      importRecipes(
        local.db,
        account.miltonUserId,
        [source, created],
        expected,
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      importRecipes(
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
      sql`DELETE FROM recipes WHERE user_id=${account.miltonUserId} AND name=${created.name}`,
    );
    expect(
      (
        await importRecipes(
          local.db,
          account.miltonUserId,
          [created],
          new Map(),
        )
      ).map((row) => row.version),
    ).toEqual([1]);
    expect(
      (
        await loadImportSources(new URL("./fixtures/recipes/", import.meta.url))
      ).map((row) => row.name),
    ).toEqual(["sample"]);
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
    const first = await store.createRecipe({
      name: "new",
      description: "A recipe.",
      text: "First café\r\n",
    });
    expect(first).toMatchObject({
      name: "new",
      text: "First café\r\n",
      archived: false,
    });
    expect(first.version).toMatch(/^new@1·/);
    const updated = await store.updateRecipe({
      name: "new",
      text: "Second",
      reason: "A preference",
      expected_version: first.version,
    });
    expect(updated).toMatchObject({ description: "A recipe." });
    expect(updated.version).toMatch(/^new@2·/);
    for (const tag of [
      first.version,
      "new@2·unknown",
      "new@02·unknown",
      "invalid",
    ]) {
      await expect(
        store.updateRecipe({
          name: "new",
          text: "Lost",
          reason: "Retry",
          expected_version: tag,
        }),
      ).rejects.toMatchObject({
        code: "recipe_version_conflict",
        details: { current: updated },
      });
    }
    await expect(
      store.createRecipe({ name: "new", description: "Other", text: "Other" }),
    ).rejects.toMatchObject({ code: "recipe_version_conflict" });
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
    const otherRecipe = await other.createRecipe({
      name: "new",
      description: "Other tenant.",
      text: "Other tenant body",
    });
    expect((await other.history("new")).items).toHaveLength(1);
    expect(
      (await other.downloadRecipes()).find((recipe) => recipe.name === "new")
        ?.text,
    ).toBe("Other tenant body");
    await expect(
      person.deleteRecipe({
        name: "new",
        expected_version: otherRecipe.version,
        confirmation: "new",
      }),
    ).rejects.toMatchObject({ code: "recipe_version_conflict" });
    await person.deleteRecipe({
      name: "new",
      expected_version: updated.version,
      confirmation: "new",
    });
    expect((await other.getRecipe("new"))?.text).toBe("Other tenant body");
    const recreated = await store.createRecipe({
      name: "new",
      description: "Recreated",
      text: "New life",
    });
    expect(recreated.version).not.toBe(first.version);
    await expect(
      store.archiveRecipe({
        name: "new",
        reason: "Stale",
        expected_version: first.version,
      }),
    ).rejects.toMatchObject({
      code: "recipe_version_conflict",
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
    const created = await person.createRecipe({
      name: "sample",
      description: "Sample.",
      text: "Original",
    });
    const archived = await person.archiveRecipe({
      name: "sample",
      expected_version: created.version,
      reason: "Archive",
    });
    await expect(
      person.archiveRecipe({
        name: "sample",
        expected_version: archived.version,
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "recipe_state_conflict" });
    const edited = await person.updateRecipe({
      name: "sample",
      expected_version: archived.version,
      reason: "Edit while archived",
      text: "Archived edit",
    });
    expect(edited.archived).toBe(true);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"history_bytes":1,"daily_writes":4}'::jsonb`,
    );
    await expect(
      person.updateRecipe({
        name: "sample",
        expected_version: edited.version,
        reason: "Too much",
        text: "Fail",
      }),
    ).rejects.toMatchObject({ code: "recipe_history_limit" });
    expect((await person.usage()).writes).toBe(3);
    await local.pg.exec(
      `UPDATE store_config SET limits_json=limits_json || '{"daily_writes":3}'::jsonb`,
    );
    await expect(
      person.updateRecipe({
        name: "sample",
        expected_version: edited.version,
        reason: "Over daily",
        text: "Fail",
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      details: { limit: "writes" },
    });
    const restored = await person.restoreRecipe({
      name: "sample",
      expected_version: edited.version,
    });
    expect(restored.text).toBe("Archived edit");
    expect(restored.archived).toBe(false);
    const reverted = await person.revertRecipe({
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
    expect(history.items.map((v) => v.version)).toEqual([5, 4]);
    expect(history.next_cursor).toBe("4");
    expect(
      (await paged.history("sample", history.next_cursor!)).items.map(
        (v) => v.version,
      ),
    ).toEqual([3, 2]);
    await expect(
      person.deleteRecipe({
        name: "sample",
        expected_version: reverted.version,
        confirmation: "wrong",
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    await person.deleteRecipe({
      name: "sample",
      expected_version: reverted.version,
      confirmation: "sample",
    });
    expect(await person.getRecipe("sample")).toBeNull();
    expect((await person.history("sample")).items).toEqual([]);
    expect((await person.downloadRecipes()).map((v) => v.name)).not.toContain(
      "sample",
    );
  } finally {
    await local.dispose();
  }
}, 30000);
