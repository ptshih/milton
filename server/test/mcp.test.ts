import { sql, type SQL } from "drizzle-orm";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkMcp } from "../scripts/check-mcp";
import { loadMemos } from "../src/memos";
import { createMiltonServer } from "../src/mcp";
import { createMiltonHandler } from "../src/handler";
import { createAccessTokenVerifier } from "../src/token";
import { resolveIdentityAccount } from "../src/store";
import { localStore } from "./local-store";
import { z } from "zod";

const issuer = "https://auth.example/milton/auth";
const origin = "http://localhost:3001";
const resource = origin + "/mcp";
async function tokenFixture(target = resource) {
  const key = await generateKeyPair("EdDSA");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture",
    alg: "EdDSA",
  };
  return {
    verify: createAccessTokenVerifier({ issuer, resource: target }, async () =>
      Response.json({ keys: [jwk] }),
    ),
    token: (subject: string) =>
      new SignJWT({
        sub: subject,
        client_id: "verified-client",
        scope: "openid",
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(target)
        .setExpirationTime("1h")
        .sign(key.privateKey),
  };
}

test("an SDK client receives instructions, discovers two tools, and reads TPS", async () => {
  const calls: string[] = [];
  const server = createMiltonServer(
    await loadMemos(new URL("../../templates/", import.meta.url)),
    () => "sdk-test",
    (call) => calls.push(call.tool),
  );
  const client = new Client({ name: "sdk-test", version: "0.0.0" });
  expect(server).toBeInstanceOf(McpServer);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(await checkMcp(client)).toContain("exactly two");
    expect(calls).toEqual(["get_tps_report"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("two authenticated tools isolate tenants, save once and reject retired tools", async () => {
  const local = await localStore();
  const clients: Client[] = [];
  let modelCalls = 0;
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    for (const subject of ["alpha", "beta"])
      await resolveIdentityAccount(local.env, { provider: "neon", subject });
    const fixture = await tokenFixture();
    const handler = createMiltonHandler(
      {
        ...local.env,
        MEMOS_SOURCE: "store",
        issuer,
        resource,
        appOrigin: origin,
        memoCompiler: {
          reserveMicros: 100,
          accountBudgetMicros: 10000,
          globalBudgetMicros: 20000,
          async compile(input) {
            modelCalls++;
            return {
              decision: "apply",
              memos: [
                {
                  id: null,
                  description: "Working instructions",
                  text: input.text,
                },
              ],
              tps: input.text,
              message: "File instructions.",
            };
          },
        },
      },
      fixture.verify,
    );
    for (const subject of ["alpha", "beta"]) {
      const client = new Client({ name: "claimed-client", version: "0.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          fetch: (input, init) => {
            const request = new Request(input, init);
            request.headers.set("Host", new URL(request.url).host);
            request.headers.set("X-Milton-User-Id", "another-account");
            return handler(request);
          },
          requestInit: {
            headers: {
              Authorization: `Bearer ${await fixture.token(subject)}`,
            },
          },
        }),
      );
    }
    const call = async (
      i: number,
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const reply = await clients[i]!.callTool({ name, arguments: args });
      const content = z
        .object({
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
        })
        .parse(reply);
      return {
        value: z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(content.content[0]!.text)),
        isError: reply.isError,
      };
    };
    const discovered = (await clients[0]!.listTools()).tools;
    expect(discovered.map((t) => t.name).sort()).toEqual([
      "get_tps_report",
      "save_memo",
    ]);
    expect(
      discovered.find((t) => t.name === "get_tps_report")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(
      discovered.find((t) => t.name === "save_memo")?.annotations
        ?.idempotentHint,
    ).toBe(true);
    expect(clients[0]!.getInstructions()).toContain("instructions");
    expect(clients[0]!.getInstructions()).not.toContain("update_memo");
    const first = (await call(0, "get_tps_report")).value;
    const second = (await call(1, "get_tps_report")).value;
    expect(first.text).toBe("");
    expect(second.text).toBe("");
    const input = {
      text: "Lead with the answer.",
      request_id: crypto.randomUUID(),
      expected_version: first.version,
    };
    const saved = await call(0, "save_memo", input);
    expect(saved.value.status).toBe("saved");
    expect(await call(0, "save_memo", input)).toEqual(saved);
    expect(modelCalls).toBe(1);
    expect((await call(0, "get_tps_report")).value.text).toBe(input.text);
    expect((await call(1, "get_tps_report")).value.text).toBe("");
    expect(
      (
        await call(1, "save_memo", {
          ...input,
          request_id: crypto.randomUUID(),
        })
      ).value.status,
    ).toBe("conflict");
    expect(modelCalls).toBe(1);
    for (const name of [
      "list_memos",
      "get_memo",
      "search",
      "create_memo",
      "update_memo",
      "archive_memo",
      "update_tps_report",
      "tps_check",
      "check_draft",
    ]) {
      const refusal = await clients[0]!
        .callTool({ name, arguments: {} })
        .catch(() => ({ isError: true }));
      expect(refusal.isError).toBe(true);
    }
    expect(
      (await call(0, "save_memo", { ...input, text: "different" })).value.error,
    ).toBe("request_id_reused");
    const rejected = await handler(
      new Request(resource, {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Authorization: "Bearer legacy-worker-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(rejected.status).toBe(401);
    await local.db.query(
      sql`UPDATE store_config SET limits_json=limits_json || '{"daily_calls":1}'::jsonb`,
    );
    expect((await call(0, "get_tps_report")).value.error).toBe("rate_limited");
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await local.dispose();
  }
}, 30000);

test("MCP refuses unsafe transports and oversized bodies before database access", async () => {
  const resource = "https://mcp.meetmilton.com/mcp";
  let queries = 0;
  const local = await localStore();
  try {
    const db = new Proxy(local.db, {
      get(target, key) {
        if (key === "query")
          return (statement: SQL) => {
            queries++;
            return target.query(statement);
          };
        return Reflect.get(target, key);
      },
    });
    const fixture = await tokenFixture(resource);
    const handler = createMiltonHandler(
      {
        storeDatabase: db,
        issuer,
        resource,
        appOrigin: "https://mcp.meetmilton.com",
        MEMOS_SOURCE: "store",
      },
      fixture.verify,
    );
    for (const [method, host, origin, expected] of [
      ["GET", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["DELETE", "mcp.meetmilton.com", "https://claude.ai", 405],
      ["POST", "untrusted.example", "https://claude.ai", 403],
      ["POST", "localhost:3001", "https://claude.ai", 403],
      ["POST", "mcp.meetmilton.com", "https://untrusted.example", 403],
      ["OPTIONS", "mcp.meetmilton.com", "https://claude.ai", 200],
      ["POST", "mcp.meetmilton.com", "https://chatgpt.com", 401],
    ] as const) {
      const reply = await handler(
        new Request(resource, {
          method,
          headers: {
            Host: host,
            Origin: origin,
            "Content-Type": "application/json",
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      );
      expect(reply.status).toBe(expected);
      expect(reply.headers.get("Access-Control-Expose-Headers")).toContain(
        "WWW-Authenticate",
      );
      expect(queries).toBe(0);
      if (expected === 401) {
        expect(reply.headers.get("WWW-Authenticate")).toContain(
          "resource_metadata=",
        );
        expect(reply.headers.get("WWW-Authenticate")).not.toContain("scope=");
      }
    }
    const oversized = await handler(
      new Request(resource, {
        method: "POST",
        headers: { Host: "mcp.meetmilton.com" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
            c.close();
          },
        }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(queries).toBe(0);
  } finally {
    await local.dispose();
  }
}, 30000);

test("tool dispatch logs accepted calls, invalid arguments, and unknown tools exactly once", async () => {
  const calls: unknown[] = [];
  const server = createMiltonServer(
    await loadMemos(new URL("../../templates/", import.meta.url)),
    () => "registered-client",
    (call) => calls.push(call),
  );
  const client = new Client({ name: "claimed-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "get_tps_report", arguments: {} });
    const invalid = await client.callTool({
      name: "save_memo",
      arguments: { text: 1 },
    });
    expect(invalid.isError).toBe(true);
    await client
      .callTool({ name: "unknown-tool", arguments: { private: "not logged" } })
      .catch(() => {});
    expect(calls).toEqual([
      { client: "registered-client", tool: "get_tps_report" },
      { client: "registered-client", tool: "save_memo" },
      { client: "registered-client", tool: "unknown-tool" },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
