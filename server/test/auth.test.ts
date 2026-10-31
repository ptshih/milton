import { expect, test, spyOn } from "bun:test";
import { memoWrites } from "../src/store/writes";
import { sql } from "drizzle-orm";
import {
  NEON_AUTH_SESSION_COOKIE_NAME,
  NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
} from "@neondatabase/auth/server";
import { createMiltonApp } from "../src/index";
import { navigation, page } from "../src/pages";
import {
  resolveIdentityAccount,
  lookupIdentityAccount,
  personStoreForCurrentRequest,
  storeForCurrentRequest,
} from "../src/store";
import { localStore } from "./local-store";

const appOrigin = "http://localhost:3001";
const issuer = "https://auth.example/milton/auth";
const resource = appOrigin + "/mcp";
const signedQuery =
  "client_id=fixture&resource=" +
  encodeURIComponent(resource) +
  "&redirect_uri=" +
  encodeURIComponent("http://localhost:9999/callback") +
  "&scope=openid%20profile&state=a%2Bb&sig=fixture%2Fsignature&ba_param=client_id&ba_param=resource&ba_param=sig";

test("page fonts are local while the other browser restrictions stay closed", async () => {
  const response = page("Example", "<p>Example</p>");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; font-src 'self'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  );
  const { localAsset } = await import("../scripts/assets");
  for (const [path, type] of [
    ["/fonts/source-serif-4-semibold.woff2", "font/woff2"],
    ["/fonts/jetbrains-mono-regular.woff2", "font/woff2"],
    ["/favicon.svg", "image/svg+xml"],
    ["/milton.css", "text/css; charset=utf-8"],
  ]) {
    const asset = localAsset(new Request(appOrigin + path));
    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("Content-Type")).toBe(type);
    expect((await asset!.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(
      localAsset(new Request(appOrigin + path, { method: "POST" }))?.status,
    ).toBe(405);
    expect(
      await localAsset(
        new Request(appOrigin + path, { method: "HEAD" }),
      )!.text(),
    ).toBe("");
  }
  for (const path of [
    "/fonts/unknown.woff2",
    "/fonts/../secret",
    "/fonts/%2e%2e/secret",
    "/src/pages.ts",
  ])
    expect(localAsset(new Request(appOrigin + path))).toBeNull();
});

test("Neon server adapter preserves signed queries, cookies, sign-in admission and Allow/Deny", async () => {
  const local = await localStore();
  const jar = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let metadataAvailable = true;
  const now = new Date().toISOString();
  const session = {
    session: {
      id: "fixture-session",
      token: "fixture-session-token",
      userId: "neon-browser",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: now,
      updatedAt: now,
    },
    user: {
      id: "neon-browser",
      name: "Fixture",
      email: "fixture@example.invalid",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  };
  const upstream = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== new URL(issuer).origin)
          throw new Error("Unexpected upstream host");
        const path = url.pathname.slice(new URL(issuer).pathname.length);
        const body =
          request.method === "POST"
            ? ((await request.json()) as Record<string, unknown>)
            : {};
        calls.push({ path, body });
        if (path === "/get-session") {
          if (url.searchParams.has("neon_auth_session_verifier")) {
            const headers = new Headers();
            headers.append(
              "Set-Cookie",
              `${NEON_AUTH_SESSION_COOKIE_NAME}=fixture-session-token; Path=/; Secure; HttpOnly`,
            );
            headers.append(
              "Set-Cookie",
              `${NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME}=; Path=/; Secure; HttpOnly; Max-Age=0`,
            );
            return Response.json(session, { headers });
          }
          return Response.json(
            request.headers
              .get("Cookie")
              ?.includes(NEON_AUTH_SESSION_COOKIE_NAME + "=")
              ? session
              : null,
          );
        }
        if (body.oauth_query && String(body.oauth_query).includes("sig=forged"))
          return Response.json(
            { code: "INVALID_SIGNATURE", message: "fixture rejected query" },
            { status: 400 },
          );
        if (path === "/sign-in/social")
          return Response.json(
            { url: issuer + "/social", redirect: true },
            {
              headers: {
                "Set-Cookie": `${NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME}=fixture-challenge; Path=/; Secure; HttpOnly`,
              },
            },
          );
        if (path === "/oauth2/continue")
          return Response.json({
            url: appOrigin + "/consent?" + body.oauth_query,
            redirect: true,
          });
        if (path === "/oauth2/get-consents")
          return metadataAvailable
            ? Response.json([{ clientId: "fixture" }])
            : Response.json({ message: "Unavailable" }, { status: 503 });
        if (path === "/oauth2/public-client")
          return Response.json({
            client_id: "fixture",
            client_name: '<script>alert("client")</script>',
            client_uri: "https://client.example",
          });
        if (path === "/oauth2/consent")
          return Response.json({
            url:
              "http://localhost:9999/callback?" +
              (body.accept ? "code=fixture-code" : "error=access_denied"),
            redirect: true,
          });
        if (path === "/sign-out") return Response.json({ success: true });
        throw new Error("Unexpected upstream endpoint");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    const app = createMiltonApp({
      ...local.env,
      issuer,
      resource,
      appOrigin,
      cookieSecret: crypto.randomUUID(),
    });
    const send = async (
      path: string,
      body?: URLSearchParams,
      cookieOverride?: string,
    ) => {
      const response = await app(
        new Request(appOrigin + path, {
          method: body ? "POST" : "GET",
          headers: {
            Host: "localhost:3001",
            Cookie:
              cookieOverride ??
              [...jar].map(([k, v]) => k + "=" + v).join("; "),
            ...(body
              ? {
                  Origin: appOrigin,
                  "Content-Type": "application/x-www-form-urlencoded",
                }
              : {}),
          },
          ...(body ? { body } : {}),
        }),
      );
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(";");
        const at = pair!.indexOf("=");
        jar.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
      return response;
    };
    const login = await send("/login?" + signedQuery);
    const loginHtml = await login.text();
    expect(login.status).toBe(200);
    expect(loginHtml).toContain("Continue with Google");
    expect(login.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(loginHtml)![1]!;
    const start = await send(
      "/login",
      new URLSearchParams({
        csrf,
        provider: "google",
        oauth_query: signedQuery,
      }),
    );
    expect(start.status).toBe(200);
    expect(await start.text()).toContain('http-equiv="refresh"');
    const signIn = calls.find((call) => call.path === "/sign-in/social")!;
    expect(signIn.body.oauth_query).toBe(signedQuery);
    expect(
      start.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.includes("SameSite=Lax") &&
            cookie.includes("HttpOnly") &&
            cookie.includes("Secure") &&
            !cookie.includes("Domain="),
        ),
    ).toBe(true);
    const callbackURL = new URL(String(signIn.body.callbackURL));
    callbackURL.searchParams.set(
      "neon_auth_session_verifier",
      "fixture-verifier",
    );
    const callback = await send(callbackURL.pathname + callbackURL.search);
    expect(callback.status).toBe(302);
    expect(callback.headers.getSetCookie().length).toBeGreaterThanOrEqual(2);
    const completed = await send(
      new URL(callback.headers.get("Location")!).pathname +
        new URL(callback.headers.get("Location")!).search,
    );
    expect(completed.status).toBe(200);
    expect(
      calls.find((call) => call.path === "/oauth2/continue")?.body.oauth_query,
    ).toBe(signedQuery);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 1 }]);
    const consent = await send("/consent?" + signedQuery);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("read and change your memos");
    expect(consentHtml).toContain("&lt;script&gt;");
    expect(consentHtml).not.toContain("<script>");
    expect(consentHtml).toContain("(name not verified)");
    expect(consentHtml).toContain(
      "Only allow this if you just started connecting it.",
    );
    expect(consentHtml).not.toContain("Requested sign-in information:");
    expect(consentHtml).not.toContain("Resource:");
    const cimd = await send(
      "/consent?" +
        signedQuery.replace(
          "client_id=fixture",
          "client_id=" +
            encodeURIComponent("https://metadata.example/client.json"),
        ),
    );
    const cimdHtml = await cimd.text();
    expect(cimdHtml).toContain(", from metadata.example");
    expect(cimdHtml).not.toContain("name not verified");
    expect(cimdHtml).not.toContain("client.example");
    const consentCsrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)![1]!;
    for (const decision of ["allow", "deny"]) {
      const response = await send(
        "/consent",
        new URLSearchParams({
          csrf: consentCsrf,
          decision,
          oauth_query: signedQuery,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        decision === "allow" ? "code=fixture-code" : "error=access_denied",
      );
      expect(calls.at(-1)?.body.oauth_query).toBe(signedQuery);
    }
    const forged = await send(
      "/consent",
      new URLSearchParams({
        csrf: consentCsrf,
        decision: "allow",
        oauth_query: signedQuery.replace(
          "sig=fixture%2Fsignature",
          "sig=forged",
        ),
      }),
    );
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain("Restart");
    expect(
      (
        await send(
          "/consent",
          new URLSearchParams({
            csrf: consentCsrf,
            decision: "allow",
            oauth_query: signedQuery,
          }),
          "",
        )
      ).status,
    ).toBe(403);
    expect(
      (await send("/login?client_id=fixture&sig=missing-resource")).status,
    ).toBe(400);
    const forced = signedQuery + "&prompt=login&max_age=0";
    expect((await send("/login?" + forced)).status).toBe(200);
    const repeated = await send("/login?" + forced);
    expect(repeated.status).toBe(400);
    expect(await repeated.text()).toContain("Sign-in requested again");
    expect(
      (
        await send(
          "/consent?" +
            signedQuery +
            "&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
        )
      ).status,
    ).toBe(400);
    const home = await send("/");
    const homeHtml = await home.text();
    expect(homeHtml).toContain("<h1>TPS Report</h1>");
    expect(homeHtml).not.toContain("Version history");
    expect(homeHtml).not.toContain("Your memos");
    expect((await send("/new-memo")).status).toBe(404);
    const browserPost = async (
      path: string,
      fields: Record<string, string>,
      origin = appOrigin,
    ) => {
      const form = new FormData();
      form.set("csrf", jar.get("milton-csrf")!);
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return app(
        new Request(appOrigin + path, {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Origin: origin,
            Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          },
          body: form,
        }),
      );
    };
    for (const path of ["/memos", "/memos/new/archive", "/tps-report/revert"]) {
      expect((await browserPost(path, {})).status).toBe(404);
    }
    const currentCsrf = jar.get("milton-csrf")!;
    const sameOriginNull = await app(
      new Request(appOrigin + "/consent", {
        method: "POST",
        headers: {
          Host: "localhost:3001",
          Origin: "null",
          "Sec-Fetch-Site": "same-origin",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrf: currentCsrf,
          decision: "deny",
          oauth_query: signedQuery,
        }),
      }),
    );
    expect(sameOriginNull.status).toBe(200);
    const expires = session.session.expiresAt;
    session.session.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(
      (
        await browserPost("/memos", {
          name: "expired",
          description: "Expired",
          text: "No",
        })
      ).status,
    ).toBe(403);
    session.session.expiresAt = expires;
    const signedOut = await send(
      "/logout",
      new URLSearchParams({ csrf: currentCsrf }),
    );
    expect(signedOut.status).toBe(200);
    expect(
      signedOut.headers
        .getSetCookie()
        .some(
          (cookie) =>
            cookie.startsWith("milton-csrf=") && cookie.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(
      await local.db.query(sql`SELECT count(*)::integer AS n FROM users`),
    ).toEqual([{ n: 1 }]);
  } finally {
    upstream.mockRestore();
    await local.dispose();
  }
}, 30000);

test("consent shows an escaped, unverified client ID when the client has no name", async () => {
  const local = await localStore();
  const clientId = "fixture<client>";
  const upstream = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin !== new URL(issuer).origin)
          throw new Error("Unexpected upstream host");
        if (url.pathname === new URL(issuer).pathname + "/get-session")
          return Response.json({
            user: { id: "neon-unnamed-client" },
            session: {
              userId: "neon-unnamed-client",
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          });
        if (url.pathname === new URL(issuer).pathname + "/oauth2/public-client")
          return Response.json({ client_id: clientId });
        throw new Error("Unexpected upstream endpoint");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
    await resolveIdentityAccount(local.env, {
      provider: "neon",
      subject: "neon-unnamed-client",
    });
    const app = createMiltonApp({
      ...local.env,
      issuer,
      resource,
      appOrigin,
      cookieSecret: crypto.randomUUID(),
    });
    const query = signedQuery.replace(
      "client_id=fixture",
      "client_id=" + encodeURIComponent(clientId),
    );
    const response = await app(
      new Request(appOrigin + "/consent?" + query, {
        headers: {
          Host: "localhost:3001",
          Cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=fixture-session-token`,
        },
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<strong>fixture&lt;client&gt;</strong>");
    expect(html).not.toContain(clientId);
    expect(html).toContain("(name not verified)");
    expect(html).toContain('value="allow"');
    expect(html).toContain('value="deny"');
  } finally {
    upstream.mockRestore();
    await local.dispose();
  }
}, 30000);

test("navigation accepts native Allow/Deny callbacks while rejecting unsafe destinations", async () => {
  for (const result of ["code=fixture-code", "error=access_denied"]) {
    const response = navigation(
      "cursor://anysphere.cursor-mcp/oauth/callback?" +
        result +
        "&state=fixture",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'href="cursor://anysphere.cursor-mcp/oauth/callback?' +
        result +
        '&amp;state=fixture"',
    );
    expect(html).toContain('http-equiv="refresh"');
  }
  for (const target of [
    "native+app:/oauth/callback",
    "com.example.app:/oauth/callback",
    "https://client.example/callback",
    "http://localhost:9999/callback",
    "http://127.0.0.1:9999/callback",
    "http://[::1]:9999/callback",
  ])
    expect(navigation(target).status).toBe(200);
  for (const target of [
    "javascript:alert(1)",
    "data:text/html,fixture",
    "vbscript:msgbox(1)",
    "file:///tmp/fixture",
    "blob:https://client.example/fixture",
    "http://client.example/callback",
    "https://user:pass@client.example/callback",
    "cursor://user:pass@anysphere.cursor-mcp/oauth/callback",
    "https://client.example/callback\r\nfixture",
    "cursor://anysphere.cursor-mcp/oauth/callback\nfixture",
  ])
    expect(() => navigation(target)).toThrow(
      "The sign-in destination is unavailable.",
    );
});

test("resource discovery is public and browser mutations reject foreign origins", async () => {
  const app = createMiltonApp({
    issuer,
    resource,
    appOrigin,
    cookieSecret: crypto.randomUUID(),
  });
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const reply = await app(
      new Request(appOrigin + path, { headers: { Host: "localhost:3001" } }),
    );
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  }
  const denied = await app(
    new Request(appOrigin + "/login", {
      method: "POST",
      headers: {
        Host: "localhost:3001",
        Origin: "https://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "csrf=bad&provider=google",
    }),
  );
  expect(denied.status).toBe(403);
  expect(
    (
      await app(
        new Request(appOrigin + "/api/auth/admin/list-users", {
          headers: { Host: "localhost:3001" },
        }),
      )
    ).status,
  ).toBe(404);
});

test("pages on the MCP host redirect to the app host; assistant routes stay", async () => {
  const app = createMiltonApp({
    issuer,
    resource: "https://mcp.meetmilton.com/mcp",
    appOrigin: "https://app.meetmilton.com",
    cookieSecret: crypto.randomUUID(),
  });
  const page = await app(
    new Request("https://mcp.meetmilton.com/memos/vibes?tab=history", {
      headers: { Host: "mcp.meetmilton.com" },
    }),
  );
  expect(page.status).toBe(308);
  expect(page.headers.get("Location")).toBe(
    "https://app.meetmilton.com/memos/vibes?tab=history",
  );
  const discovery = await app(
    new Request(
      "https://mcp.meetmilton.com/.well-known/oauth-protected-resource/mcp",
      { headers: { Host: "mcp.meetmilton.com" } },
    ),
  );
  expect(discovery.status).toBe(200);
});

async function memoPageFixture() {
  const local = await localStore();
  await local.db.query(sql`UPDATE store_config SET signup_mode='open'`);
  await resolveIdentityAccount(local.env, {
    provider: "neon",
    subject: "page-fixes",
  });
  const account = await lookupIdentityAccount(local.env, {
    provider: "neon",
    subject: "page-fixes",
  });
  const store = await personStoreForCurrentRequest(local.env, account);
  const author = await storeForCurrentRequest(
    {
      ...local.env,
      memoCompiler: {
        reserveMicros: 100,
        accountBudgetMicros: 10000,
        globalBudgetMicros: 20000,
        async compile(input) {
          return {
            decision: "apply",
            memos: [
              {
                id: input.memos[0]?.id ?? null,
                description: "Instructions",
                text: input.text,
              },
            ],
            tps: input.text,
            message: "File instructions.",
          };
        },
      },
    },
    account,
    { issuer, clientId: "fixture" },
  );
  const upstream = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href !== issuer + "/get-session")
          throw new Error("Unexpected upstream endpoint");
        return Response.json({
          user: { id: "page-fixes" },
          session: {
            userId: "page-fixes",
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const app = createMiltonApp({
    ...local.env,
    issuer,
    resource,
    appOrigin,
    cookieSecret: crypto.randomUUID(),
  });
  const jar = new Map<string, string>();
  return {
    store,
    author,
    db: local.db,
    async send(path: string, fields?: Record<string, string>) {
      const body = fields ? new FormData() : undefined;
      if (body) {
        body.set("csrf", jar.get("milton-csrf")!);
        for (const [key, value] of Object.entries(fields!))
          body.set(key, value);
      }
      const response = await app(
        new Request(appOrigin + path, {
          method: body ? "POST" : "GET",
          headers: {
            Host: "localhost:3001",
            Cookie: [...jar]
              .map(([key, value]) => key + "=" + value)
              .join("; "),
            ...(body ? { Origin: appOrigin } : {}),
          },
          body,
        }),
      );
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0]!;
        const at = pair.indexOf("=");
        jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    },
    async dispose() {
      upstream.mockRestore();
      await local.dispose();
    },
  };
}

test("web shows only current TPS and rejects all retired history and mutation routes", async () => {
  const fixture = await memoPageFixture();
  try {
    const empty = await (await fixture.send("/")).text();
    expect(empty).toContain("No instructions on file.");
    const first = await fixture.author.readTpsReport();
    const body = "Lead with the answer. <script>alert('fixture')</script>";
    const outcome = await fixture.author.saveMemo({
      text: body,
      expected_version: first.version,
      request_id: crypto.randomUUID(),
    });
    expect(outcome.status).toBe("saved");
    const html = await (await fixture.send("/tps-report")).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    for (const absent of [
      "Version history",
      "Restore",
      "Archive",
      "Your memos",
      "<textarea",
      "writes today",
    ])
      expect(html).not.toContain(absent);
    const before = await fixture.db.query(
      sql`SELECT * FROM memo_versions ORDER BY user_id,memo_id,version`,
    );
    for (const path of [
      "/memos",
      "/memos/sample",
      "/memos/sample/history",
      "/memos/sample/archive",
      "/memos/sample/restore",
      "/memos/sample/revert",
      "/tps-report/history",
      "/tps-report/history/1",
      "/tps-report/revert",
    ]) {
      expect((await fixture.send(path)).status).toBe(404);
      expect((await fixture.send(path, {})).status).toBe(404);
    }
    expect(
      await fixture.db.query(
        sql`SELECT * FROM memo_versions ORDER BY user_id,memo_id,version`,
      ),
    ).toEqual(before);
    const download = await fixture.send("/download");
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="TPS.md"',
    );
    expect(await download.text()).toBe(body);
  } finally {
    await fixture.dispose();
  }
}, 30000);
