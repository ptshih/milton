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
    expect(homeHtml).toContain("<h1>Your TPS Report</h1>");
    expect(homeHtml).toContain("<h2>Your memos</h2>");
    expect(homeHtml.indexOf('href="/tps-report"')).toBeLessThan(
      homeHtml.indexOf("<h2>Your memos</h2>"),
    );
    expect(homeHtml.match(/href="\/tps-report"/g)).toHaveLength(2);
    expect((await send("/?result=constructor")).status).toBe(200);
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
    const account = await lookupIdentityAccount(local.env, {
      provider: "neon",
      subject: "neon-browser",
    });
    const person = await personStoreForCurrentRequest(local.env, account);
    const assistant = await storeForCurrentRequest(local.env, account, {
      issuer,
      clientId: "fixture",
    });
    await assistant.createMemo({
      name: "new",
      description: "A page memo.",
      text: "Original </textarea><script>alert(1)</script>",
    });
    expect(
      (
        await browserPost("/memos", {
          name: "refused",
          description: "No",
          text: "No",
        })
      ).status,
    ).toBe(404);
    const editor = await send("/memos/new");
    const editorHtml = await editor.text();
    expect(editorHtml).toContain("<dt>Version</dt><dd>1</dd>");
    expect(editorHtml).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(editorHtml).not.toContain("<script>");
    const tag = /name="expected_version" value="([^"]+)"/.exec(editorHtml)![1]!;
    const memoId = /name="memo_id" value="([^"]+)"/.exec(editorHtml)![1]!;
    await assistant.updateMemo({
      name: "new",
      expected_version: tag,
      description: "Edited.",
      text: "Changed café",
      reason: "Approved preference",
    });
    const conflict = await browserPost("/memos/new/archive", {
      expected_version: tag,
      memo_id: memoId,
    });
    expect(conflict.status).toBe(409);
    const conflictHtml = await conflict.text();
    expect(conflictHtml).toContain('role="alert"');
    expect(conflictHtml).toContain("Changed café");
    expect(conflictHtml).not.toContain("<textarea");
    expect(
      (
        await browserPost(
          "/memos/new/archive",
          { expected_version: tag, memo_id: memoId },
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    const tpsHtml = await (await send("/tps-report")).text();
    expect(tpsHtml).not.toContain("Archive memo");
    expect(tpsHtml).not.toContain("Delete memo");
    expect(tpsHtml).not.toContain("<textarea");
    expect(tpsHtml).toContain("Version history");
    for (const action of ["archive", "delete", "save", "restore"]) {
      expect(
        (
          await browserPost(`/tps-report/${action}`, {
            expected_version: tag,
            memo_id: memoId,
          })
        ).status,
      ).toBe(404);
    }
    for (const path of ["/", "/tps-report"]) {
      await local.db.query(
        sql`DELETE FROM memos WHERE user_id=${account.userId} AND name='vibes'`,
      );
      expect((await send(path)).status).toBe(200);
      expect(await person.getMemo("vibes")).toMatchObject({
        text: "",
        archived: false,
      });
      expect((await person.history("vibes")).items).toMatchObject([
        { version: 1, reason: "Created TPS Report", actor: { kind: "system" } },
      ]);
    }
    await assistant.createMemo({
      name: "assistant",
      description: "Assistant attribution.",
      text: "A preference",
    });
    const namedHistory = await send("/memos/assistant/history");
    expect(await namedHistory.text()).toContain(
      "&lt;script&gt;alert(&quot;client&quot;)&lt;/script&gt;",
    );
    expect(
      calls.filter((call) => call.path === "/oauth2/get-consents"),
    ).toHaveLength(1);
    metadataAvailable = false;
    const unnamedHistory = await send("/memos/assistant/history");
    expect(unnamedHistory.status).toBe(200);
    expect(await unnamedHistory.text()).toContain("fixture");
    metadataAvailable = true;
    // Historical import IDs are stored data, even after the public rename.
    for (const [index, id] of ["recipe-import", "memo-import"].entries()) {
      await local.db.query(sql`INSERT INTO memo_versions
        (user_id,memo_id,version,description,body,reason,actor_json)
        SELECT user_id,id,${index + 2},'Imported.','Kept text','Import',${JSON.stringify({ kind: "system", id })}
        FROM memos WHERE user_id=${account.userId} AND name='assistant'`);
      expect(
        await (await send(`/memos/assistant/history/${index + 2}`)).text(),
      ).toContain("Memo import");
    }
    for (const variant of ["duplicate", "file", "missing-csrf"]) {
      const form = new FormData();
      if (variant !== "missing-csrf") form.set("csrf", jar.get("milton-csrf")!);
      form.set("name", "refused");
      form.set("description", "Refused.");
      form.set("text", "Refused");
      if (variant === "duplicate") form.append("text", "Duplicate");
      if (variant === "file")
        form.set("text", new File(["file content"], "memo.md"));
      const refusal = await app(
        new Request(appOrigin + "/memos", {
          method: "POST",
          headers: {
            Host: "localhost:3001",
            Origin: appOrigin,
            Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          },
          body: form,
        }),
      );
      expect(refusal.status).toBe(403);
    }
    const edited = (await person.getMemo("new"))!;
    expect(
      (
        await browserPost("/memos/new/archive", {
          expected_version: edited.version,
          memo_id: memoId,
        })
      ).status,
    ).toBe(303);
    const archived = (await person.getMemo("new"))!;
    expect(
      (
        await browserPost("/memos/new/restore", {
          expected_version: archived.version,
          memo_id: memoId,
        })
      ).status,
    ).toBe(303);
    const restored = (await person.getMemo("new"))!;
    expect(
      (
        await browserPost("/memos/new/revert", {
          expected_version: restored.version,
          memo_id: memoId,
          source_version: "1",
        })
      ).status,
    ).toBe(303);
    const history = await send("/memos/new/history");
    expect(await history.text()).toContain("Reverted to version 1");
    const selected = await send("/memos/new/history/2");
    expect(await selected.text()).toContain("+ Changed café");
    const download = await send("/download");
    expect(download.headers.get("Content-Type")).toBe("application/zip");
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="milton-memos.zip"',
    );
    const reverted = (await person.getMemo("new"))!;
    for (const confirmation of ["wrong", "new"]) {
      const refusedDelete = await browserPost("/memos/new/delete", {
        expected_version: reverted.version,
        memo_id: memoId,
        confirmation,
      });
      expect(refusedDelete.status).toBe(404);
    }
    expect((await send("/memos/new")).status).toBe(200);
    expect((await person.history("new")).items).toHaveLength(5);
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
  const author = await storeForCurrentRequest(local.env, account, {
    issuer,
    clientId: "fixture",
  });
  let failWrite = false,
    failReadAfterWrite = false,
    readsUnavailable = false;
  const storeDatabase: typeof local.db = {
    async query(statement) {
      if (readsUnavailable) throw new Error("Fixture unavailable");
      return local.db.query(statement);
    },
    async transaction(work) {
      const result = await local.db.transaction(work);
      if (failWrite) {
        failWrite = false;
        readsUnavailable = failReadAfterWrite;
        throw new Error("Fixture cleanup failed after commit");
      }
      return result;
    },
    withConnection: (work) => local.db.withConnection(work),
  };
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
    storeDatabase,
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
    personWrites: memoWrites(local.db, account.userId, { kind: "person" }),
    failNextWrite(failedRead: boolean) {
      failWrite = true;
      failReadAfterWrite = failedRead;
    },
    resumeReads() {
      readsUnavailable = false;
    },
    removeMemo: (name: string) =>
      local.db.query(
        sql`DELETE FROM memos WHERE user_id=${account.userId} AND name=${name}`,
      ),
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

test("read-only memo pages reject removed forms and recover stored ordinary and TPS versions", async () => {
  const fixture = await memoPageFixture();
  try {
    for (const forbidden of [
      "createMemo",
      "updateMemo",
      "updateTpsReport",
      "deleteMemo",
    ])
      expect(fixture.store).not.toHaveProperty(forbidden);
    const memo = await fixture.author.createMemo({
      name: "tps-report",
      description: "Original.",
      text: "Original </textarea><script>draft</script>.",
    });
    const view = await (await fixture.send("/memos/tps-report")).text();
    expect(view).not.toContain("<textarea");
    expect(view).not.toContain('name="description"');
    expect(view).not.toContain("Delete memo");
    expect(view).toContain("&lt;script&gt;draft&lt;/script&gt;");
    const fields = {
      expected_version: memo.version,
      memo_id: /name="memo_id" value="([^"]+)"/.exec(view)![1]!,
    };
    for (const path of [
      "/new-memo",
      "/new-recipe",
      "/recipes",
      "/recipes/tps-report",
      "/memos/vibes",
      "/memos/vibes/history",
      "/tps-report/save",
    ]) {
      expect((await fixture.send(path)).status).toBe(404);
    }
    for (const path of [
      "/memos",
      "/recipes",
      "/recipes/tps-report/save",
      "/memos/tps-report/save",
      "/memos/tps-report/delete",
      "/memos/vibes/revert",
      "/tps-report/archive",
      "/tps-report/delete",
    ]) {
      expect(
        (
          await fixture.send(path, {
            ...fields,
            text: "Must not write",
            recipe_id: fields.memo_id,
          })
        ).status,
      ).toBe(404);
    }
    expect(await fixture.store.getMemo(memo.name)).toEqual(memo);
    const injectedFields: Record<string, string>[] = [
      { reason: "Custom" },
      { text: "Injected" },
      { description: "Injected" },
      { recipe_id: fields.memo_id },
      { source_version: "1" },
    ];
    for (const injected of injectedFields) {
      expect(
        (
          await fixture.send(
            "/memos/tps-report/archive",
            Object.assign({}, fields, injected),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await fixture.send("/memos/tps-report/archive", fields)).status,
    ).toBe(303);
    const archived = (await fixture.store.getMemo(memo.name))!;
    const archivedView = await (await fixture.send("/memos/tps-report")).text();
    expect(archivedView).toContain(
      "Restore this memo first, then ask your connected assistant to update its instructions.",
    );
    expect(archivedView).toContain('action="/memos/tps-report/restore"');
    const conflict = await fixture.send("/memos/tps-report/archive", fields);
    expect(conflict.status).toBe(409);
    const conflictView = await conflict.text();
    expect(conflictView).toContain('role="alert"');
    expect(conflictView).toContain(archived.version);
    expect(conflictView).not.toContain("<textarea");
    expect((await fixture.store.history(memo.name)).items).toHaveLength(2);
    expect(
      (
        await fixture.send("/memos/tps-report/restore", {
          ...fields,
          expected_version: archived.version,
        })
      ).status,
    ).toBe(303);
    let current = (await fixture.store.getMemo(memo.name))!;
    expect(current.archived).toBe(false);
    const chosen = await (
      await fixture.send("/memos/tps-report/history/2")
    ).text();
    expect(chosen).toContain("Archived");
    expect(chosen).toContain("Restore this version");
    expect(chosen).toContain("creates a new version");
    for (const source_version of ["0", "2147483648", "999"]) {
      expect(
        (
          await fixture.send("/memos/tps-report/revert", {
            ...fields,
            expected_version: current.version,
            source_version,
          })
        ).status,
      ).toBe(source_version === "999" ? 422 : 400);
    }
    expect(
      (
        await fixture.send("/memos/tps-report/revert", {
          ...fields,
          expected_version: current.version,
          source_version: "2",
          text: "Injected",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture.send("/memos/tps-report/revert", {
          ...fields,
          expected_version: current.version,
          source_version: "2",
        })
      ).status,
    ).toBe(303);
    current = (await fixture.store.getMemo(memo.name))!;
    expect(current.archived).toBe(true);
    expect(current.text).toBe(memo.text);
    expect(
      (await fixture.store.history(memo.name)).items.map((v) => v.version),
    ).toEqual([4, 3, 2, 1]);
    const tps = await fixture.store.getTpsReport();
    const updated = await fixture.author.updateTpsReport({
      text: "A working preference",
      reason: "Approved draft",
      expected_version: tps.version,
    });
    const tpsHistory = await (
      await fixture.send("/tps-report/history/1")
    ).text();
    expect(tpsHistory).toContain("TPS Report: version 1");
    expect(tpsHistory).toContain('action="/tps-report/revert"');
    expect(tpsHistory).not.toContain("Archive memo");
    const tpsFields = {
      expected_version: updated.version,
      memo_id: /name="memo_id" value="([^"]+)"/.exec(tpsHistory)![1]!,
      source_version: "1",
    };
    expect((await fixture.send("/tps-report/revert", tpsFields)).status).toBe(
      303,
    );
    expect(await fixture.store.getTpsReport()).toMatchObject({
      text: "",
      archived: false,
    });
    expect(
      (await fixture.store.history("vibes")).items.map((v) => v.version),
    ).toEqual([3, 2, 1]);
    const staleTps = await fixture.send("/tps-report/revert", tpsFields);
    expect(staleTps.status).toBe(409);
    expect(await staleTps.text()).toContain("TPS Report");
    const emptyHead = await fixture.store.getTpsReport();
    await fixture.db
      .query(sql`INSERT INTO memo_versions (user_id,memo_id,version,description,body,archived,reason,actor_json,details_json)
      SELECT user_id,memo_id,4,description,body,true,'Legacy archived source','{}','{}' FROM memo_versions WHERE version=3 AND memo_id=${tpsFields.memo_id}`);
    const legacyView = await (
      await fixture.send("/tps-report/history/4")
    ).text();
    expect(legacyView).toContain("<dt>Status</dt><dd>Archived</dd>");
    expect(legacyView).toContain("The restored TPS Report stays active.");
    const repairedHead = await fixture.store.getTpsReport();
    expect(repairedHead.version).not.toBe(emptyHead.version);
    expect(
      (
        await fixture.send("/tps-report/revert", {
          ...tpsFields,
          expected_version: repairedHead.version,
          source_version: "4",
        })
      ).status,
    ).toBe(303);
    expect((await fixture.store.getTpsReport()).archived).toBe(false);
    expect((await fixture.store.getVersion("vibes", 4))?.archived).toBe(true);
    expect((await fixture.store.history("vibes")).items[0]?.reason).toBe(
      "Restored TPS Report from version 4",
    );
    expect(
      await fixture.db.query(
        sql`SELECT u.id FROM users u WHERE retained_bytes<>(SELECT sum(payload_bytes) FROM memo_versions v WHERE v.user_id=u.id)`,
      ),
    ).toEqual([]);
    const emptyView = await (await fixture.send("/tps-report")).text();
    expect(emptyView).toContain("TPS Report is empty");
    expect(emptyView).not.toContain("<textarea");
    expect(emptyView).not.toContain("Clear TPS");
    expect(emptyView).not.toContain('name="expected_version"');
    await expect(
      fixture.personWrites.createMemo({
        name: "person",
        text: "No",
        description: "No",
      }),
    ).rejects.toMatchObject({ code: "assistant_required", status: 403 });
    await expect(
      fixture.personWrites.updateMemo({
        name: memo.name,
        text: "No",
        reason: "No",
        expected_version: current.version,
      }),
    ).rejects.toMatchObject({ code: "assistant_required", status: 403 });
    const zip = await fixture.send("/download");
    expect(zip.headers.get("Content-Disposition")).toContain(
      "milton-memos.zip",
    );
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("recovery errors never retry uncertain writes or display a failed reread as current", async () => {
  const fixture = await memoPageFixture();
  try {
    const memo = await fixture.author.createMemo({
      name: "uncertain",
      description: "Exact bytes.",
      text: "x\n".repeat(16384),
    });
    const view = await (await fixture.send("/memos/uncertain")).text();
    const fields = {
      expected_version: memo.version,
      memo_id: /name="memo_id" value="([^"]+)"/.exec(view)![1]!,
    };
    fixture.failNextWrite(false);
    const uncertain = await fixture.send("/memos/uncertain/archive", fields);
    expect(uncertain.status).toBe(503);
    const html = await uncertain.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("write outcome is unavailable");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("<textarea");
    const head = (await fixture.store.getMemo("uncertain"))!;
    expect(head.archived).toBe(true);
    expect(head.text).toBe(memo.text);
    expect((await fixture.store.history("uncertain")).items).toHaveLength(2);
    fixture.failNextWrite(true);
    const unavailable = await fixture.send("/memos/uncertain/restore", {
      ...fields,
      expected_version: head.version,
    });
    expect(unavailable.status).toBe(503);
    const unavailableHtml = await unavailable.text();
    expect(unavailableHtml).toContain('role="alert"');
    expect(unavailableHtml).not.toContain('name="expected_version"');
    expect(unavailableHtml).not.toContain("Exact bytes.");
    expect(unavailableHtml).not.toContain("<textarea");
    fixture.resumeReads();
    expect((await fixture.store.history("uncertain")).items).toHaveLength(3);
    expect((await fixture.store.getMemo("uncertain"))?.text).toBe(memo.text);
    await fixture.removeMemo("uncertain");
    const absent = await fixture.send("/memos/uncertain/restore", fields);
    expect(absent.status).toBe(404);
    expect(await absent.text()).not.toContain('name="expected_version"');
  } finally {
    await fixture.dispose();
  }
}, 30000);
