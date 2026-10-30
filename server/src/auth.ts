import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAuthServer,
  extractNeonAuthCookies,
  NEON_AUTH_SESSION_DATA_COOKIE_NAME,
  processAuthMiddleware,
  resolveNeonAuthLogging,
  serializeSetCookie,
} from "@neondatabase/auth/server";
import { z } from "zod";
import type { RuntimeConfig } from "./config";
import { isLoopback } from "./config";
import {
  lookupIdentityAccount,
  resolveIdentityAccount,
  StoreError,
  personStoreForCurrentRequest,
  guardStoreRequest,
  type VerifiedStoreAuth,
} from "./store";
import { recipePages, isRecipeRoute } from "./recipe-pages";
import { AuthError } from "./token";
import { escapeHtml as e, navigation, page } from "./pages";

const sessionSchema = z.object({
  user: z.object({ id: z.string().min(1).max(512) }),
  session: z.object({ userId: z.string(), expiresAt: z.coerce.date() }),
});
const silentLog = resolveNeonAuthLogging({ logLevel: "silent" });
const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("Cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(name + "="))
    ?.slice(name.length + 1);
const equal = (left: string, right: string) =>
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));
async function timed<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AuthError(
                "auth_unavailable",
                "Sign-in is unavailable. Try again.",
                503,
              ),
            ),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function upstreamError(error: { status?: number } | null) {
  if (error)
    throw new AuthError(
      error.status && error.status >= 500
        ? "auth_unavailable"
        : "authorization_invalid",
      error.status && error.status >= 500
        ? "Sign-in is unavailable. Try again."
        : "This sign-in request is invalid or expired. Restart from your assistant.",
      error.status && error.status >= 500 ? 503 : 400,
    );
}
function oauthQuery(
  request: Request,
  config: RuntimeConfig,
  submitted?: string,
) {
  const url = new URL(request.url);
  // The wrapper survives the SDK callback's URLSearchParams reserialization.
  const query =
    submitted ?? url.searchParams.get("flow") ?? url.search.slice(1);
  if (query.length > 8192)
    throw new AuthError(
      "authorization_invalid",
      "Restart the connection from your assistant.",
      400,
    );
  if (!query && url.pathname === "/login") return "";
  const parsed = new URLSearchParams(query);
  if (
    // Neon's signed query repeats ba_param; only the fields Milton reads must be single.
    ["resource", "client_id", "redirect_uri", "sig"].some(
      (key) => parsed.getAll(key).length !== 1,
    ) ||
    parsed.get("resource") !== config.resource ||
    !parsed.get("client_id") ||
    !parsed.get("sig") ||
    !parsed.get("redirect_uri")
  )
    throw new AuthError(
      "authorization_invalid",
      "This connection request is incomplete. Restart from your assistant.",
      400,
    );
  try {
    const callback = new URL(parsed.get("redirect_uri")!);
    if (callback.username || callback.password) throw new Error();
  } catch {
    throw new AuthError(
      "authorization_invalid",
      "This return address is invalid. Restart from your assistant.",
      400,
    );
  }
  return query;
}

export function browserPages(config: RuntimeConfig) {
  const secure = !isLoopback(new URL(config.appOrigin).hostname);
  const csrfName = secure ? "__Host-milton-csrf" : "milton-csrf";
  const loopName = secure ? "__Host-milton-continue" : "milton-continue";
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const cookies: string[] = [];
    const writeCookie = (name: string, value: string, maxAge = 3600) =>
      cookies.push(
        serializeSetCookie({
          name,
          value,
          path: "/",
          httpOnly: true,
          secure,
          sameSite: "lax",
          maxAge,
        }),
      );
    let csrf = cookieValue(request, csrfName);
    const csrfField = () => {
      if (!csrf || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) {
        csrf = randomBytes(32).toString("base64url");
        writeCookie(csrfName, csrf);
      }
      return `<input type="hidden" name="csrf" value="${e(csrf)}">`;
    };
    const rotateCsrf = () => {
      csrf = randomBytes(32).toString("base64url");
      writeCookie(csrfName, csrf);
    };
    const auth = createAuthServer({
      baseUrl: config.issuer,
      cookieSecret: config.cookieSecret,
      sameSite: "lax",
      log: silentLog,
      context: () => ({
        // Admission and mutations always ask Neon for a live session, rather
        // than accepting the SDK's cached session-data cookie as revocation proof.
        getCookies: () =>
          extractNeonAuthCookies(
            (request.headers.get("Cookie") ?? "")
              .split(";")
              .filter(
                (value) =>
                  !value
                    .trim()
                    .startsWith(NEON_AUTH_SESSION_DATA_COOKIE_NAME + "="),
              )
              .join(";"),
          ),
        setCookie: (name, value, options) => {
          cookies.push(serializeSetCookie({ name, value, ...options }));
        },
        getHeader: (name) => request.headers.get(name),
        getOrigin: () => config.appOrigin,
        getFramework: () => "milton-node",
      }),
    });
    const session = async () => {
      const result = await timed(auth.getSession());
      if (result.error?.status === 401) return null;
      upstreamError(result.error);
      if (!result.data?.session || !result.data.user) return null;
      const parsed = sessionSchema.safeParse(result.data);
      if (
        !parsed.success ||
        parsed.data.user.id !== parsed.data.session.userId ||
        parsed.data.session.expiresAt.getTime() <= Date.now()
      )
        return null;
      return parsed.data.user;
    };
    const identity = async () => {
      const user = await session();
      if (!user)
        throw new AuthError(
          "session_required",
          "Sign in to Milton before continuing.",
          403,
        );
      return { provider: "neon", subject: user.id };
    };
    const readForm = async (multipart = false, bounded = request) => {
      const origin = request.headers.get("Origin");
      const sameOrigin =
        origin === config.appOrigin ||
        ((!origin || origin === "null") &&
          request.headers.get("Sec-Fetch-Site") === "same-origin" &&
          url.origin === config.appOrigin);
      const contentType = request.headers.get("Content-Type") ?? "";
      if (
        !sameOrigin ||
        !(multipart
          ? contentType.startsWith("multipart/form-data;")
          : contentType.startsWith("application/x-www-form-urlencoded"))
      )
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      let form: URLSearchParams;
      try {
        if (multipart) {
          form = new URLSearchParams();
          for (const [key, value] of await bounded.formData()) {
            if (typeof value !== "string") throw new Error();
            form.append(key, value.replaceAll("\r\n", "\n"));
          }
        } else form = new URLSearchParams(await bounded.text());
      } catch {
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      }
      const submitted = form.get("csrf");
      if (
        !csrf ||
        !submitted ||
        !/^[A-Za-z0-9_-]{43}$/.test(csrf) ||
        !/^[A-Za-z0-9_-]{43}$/.test(submitted) ||
        !equal(csrf, submitted) ||
        [...new Set(form.keys())].some((key) => form.getAll(key).length !== 1)
      )
        throw new AuthError(
          "csrf_refused",
          "Reload the page before submitting this form.",
          403,
        );
      return form;
    };
    // Presentation only. Limit both provider requests and their time on the page path.
    const optionalMetadata = async <T>(
      pending: Promise<T>,
    ): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          pending.catch(() => null),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 400);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const clientNames = async (actors: Record<string, unknown>[]) => {
      const names = new Map<string, string>();
      const wanted = [
        ...new Set(
          actors
            .filter(
              (actor) =>
                actor.kind === "assistant" &&
                actor.issuer === config.issuer &&
                typeof actor.client_id === "string",
            )
            .map((actor) => String(actor.client_id)),
        ),
      ].slice(0, 8);
      if (!wanted.length) return names;
      const grants = await optionalMetadata(auth.oauth2.getConsents());
      const parsed = z
        .array(z.object({ clientId: z.string().max(2048) }))
        .max(200)
        .safeParse(grants?.data);
      if (!grants || grants.error || !parsed.success) return names;
      const own = new Set(parsed.data.map((grant) => grant.clientId));
      await Promise.all(
        wanted
          .filter((id) => own.has(id))
          .map(async (id) => {
            const result = await optionalMetadata(
              auth.oauth2.publicClient({ query: { client_id: id } }),
            );
            const client = z
              .object({ client_name: z.string().min(1).max(200) })
              .safeParse(result?.data);
            if (result && !result.error && client.success)
              names.set(config.issuer + "\0" + id, client.data.client_name);
          }),
      );
      return names;
    };
    const renderRecipes = async (account?: VerifiedStoreAuth) => {
      const verified =
        account ?? (await lookupIdentityAccount(config, await identity()));
      const store = await personStoreForCurrentRequest(config, verified);
      let form: Record<string, string> | undefined;
      if (request.method === "POST") {
        const bounded = await guardStoreRequest(request, {
          ...config,
          RECIPES_SOURCE: "store",
        });
        if (bounded instanceof Response) return bounded;
        form = Object.fromEntries(await readForm(true, bounded));
      }
      return recipePages(request, store, csrfField, clientNames, form);
    };
    const perform = async (): Promise<Response> => {
      if (isRecipeRoute(url.pathname) && url.pathname !== "/")
        return renderRecipes();
      if (!["/", "/login", "/consent", "/logout"].includes(url.pathname))
        return page("Not found", "<p>This page does not exist.</p>", 404);
      if (
        !["GET", "POST"].includes(request.method) ||
        (url.pathname === "/logout" && request.method !== "POST") ||
        (url.pathname === "/" && request.method !== "GET")
      )
        return page(
          "Method not allowed",
          "<p>Use the page's controls to continue.</p>",
          405,
        );
      if (request.method === "GET") {
        // The toolkit skips callback exchange on its configured login pathname.
        // Our public landing page is its fallback; /login stays in skipRoutes
        // so verifier callbacks there still run before the public-route check.
        const middleware = await timed(
          processAuthMiddleware({
            request,
            pathname: url.pathname,
            skipRoutes: ["/", "/login"],
            loginUrl: config.appOrigin + "/",
            baseUrl: config.issuer,
            cookieSecret: config.cookieSecret,
            sameSite: "lax",
            log: silentLog,
          }),
        );
        cookies.push(...(middleware.cookies ?? []));
        if (middleware.action === "redirect_oauth") {
          if (middleware.redirectUrl.origin !== config.appOrigin)
            throw new AuthError(
              "authorization_invalid",
              "Restart the connection from your assistant.",
              400,
            );
          return Response.redirect(middleware.redirectUrl, 302);
        }
        if (middleware.action === "redirect_login")
          return Response.redirect(
            config.appOrigin +
              "/login?flow=" +
              encodeURIComponent(oauthQuery(request, config)),
            302,
          );
        for (const [name, value] of Object.entries(middleware.headers ?? {}))
          request.headers.set(name, value);
        if (url.pathname === "/") {
          const user = await session();
          if (!user)
            return page(
              "Your recipes, in every assistant",
              '<p><a href="/login">Sign in to Milton</a></p>',
            );
          return renderRecipes(
            await lookupIdentityAccount(config, {
              provider: "neon",
              subject: user.id,
            }),
          );
        }
        const query = oauthQuery(request, config);
        const hidden = `<input type="hidden" name="oauth_query" value="${e(query)}">`;
        if (url.pathname === "/login") {
          const user = await session();
          if (user) {
            await resolveIdentityAccount(config, {
              provider: "neon",
              subject: user.id,
            });
            rotateCsrf();
            if (!query) return Response.redirect(config.appOrigin + "/", 302);
            const params = new URLSearchParams(query);
            const marker = createHmac("sha256", config.cookieSecret)
              .update(query)
              .digest("base64url");
            if (
              (params.get("prompt")?.split(" ").includes("login") ||
                params.get("max_age") === "0") &&
              cookieValue(request, loopName) === marker
            )
              return page(
                "Sign-in requested again",
                "<p>Your assistant asked for another sign-in. Restart the connection from your assistant.</p>",
                400,
              );
            writeCookie(loopName, marker, 600);
            const result = await timed(
              auth.oauth2.continue({ selected: true, oauth_query: query }),
            );
            upstreamError(result.error);
            if (!result.data?.url)
              throw new AuthError(
                "auth_unavailable",
                "Sign-in is unavailable. Try again.",
                503,
              );
            return navigation(result.data.url);
          }
          return page(
            "Sign in to Milton",
            `<p>Choose an account to continue.</p><form method="post" action="/login">${csrfField()}${hidden}<button name="provider" value="google">Continue with Google</button><button class="secondary" name="provider" value="github">Continue with GitHub</button></form>`,
          );
        }
        await lookupIdentityAccount(config, await identity());
        const params = new URLSearchParams(query);
        const result = await timed(
          auth.oauth2.publicClient({
            query: { client_id: params.get("client_id")! },
          }),
        );
        upstreamError(result.error);
        const client = z
          .object({
            client_name: z.string().optional(),
            client_uri: z.string().optional(),
          })
          .safeParse(result.data);
        if (!client.success)
          throw new AuthError(
            "authorization_invalid",
            "Restart the connection from your assistant.",
            400,
          );
        const redirect = new URL(params.get("redirect_uri")!);
        const destination = redirect.host || redirect.protocol;
        let clientHost = "";
        try {
          const id = new URL(params.get("client_id")!);
          if (id.protocol === "https:") clientHost = id.host;
        } catch {
          /* DCR ids are not URLs. */
        }
        return page(
          "Connect an assistant",
          `<p><strong>${e(client.data.client_name || params.get("client_id")!)}</strong>${clientHost ? `, from ${e(clientHost)}` : " (name not verified)"}</p>${clientHost ? "" : "<p>Only allow this if you just started connecting it.</p>"}<p>This assistant will be able to read and change your recipes.</p><p>Return destination: ${e(destination)}</p><form method="post" action="/consent">${csrfField()}${hidden}<button name="decision" value="allow">Allow</button><button class="secondary" name="decision" value="deny">Deny</button></form>`,
        );
      }
      const form = await readForm();
      if (url.pathname === "/logout") {
        const result = await timed(auth.signOut());
        upstreamError(result.error);
        writeCookie(csrfName, "", 0);
        writeCookie(loopName, "", 0);
        return navigation(config.appOrigin + "/");
      }
      const query = oauthQuery(request, config, form.get("oauth_query") ?? "");
      if (url.pathname === "/login") {
        const provider = form.get("provider");
        if (provider !== "google" && provider !== "github")
          throw new AuthError(
            "authorization_invalid",
            "Choose a supported sign-in provider.",
            400,
          );
        const callbackURL =
          config.appOrigin +
          "/login" +
          (query ? "?flow=" + encodeURIComponent(query) : "");
        const result = await timed(
          auth.signIn.social({
            provider,
            callbackURL,
            ...(query ? { oauth_query: query } : {}),
          }),
        );
        upstreamError(result.error);
        if (!result.data?.url)
          throw new AuthError(
            "auth_unavailable",
            "Sign-in is unavailable. Try again.",
            503,
          );
        rotateCsrf();
        return navigation(result.data.url);
      }
      await lookupIdentityAccount(config, await identity());
      const decision = form.get("decision");
      if (decision !== "allow" && decision !== "deny")
        throw new AuthError(
          "authorization_invalid",
          "Choose Allow or Deny.",
          400,
        );
      const result = await timed(
        auth.oauth2.consent({
          accept: decision === "allow",
          oauth_query: query,
        }),
      );
      upstreamError(result.error);
      if (!result.data?.url)
        throw new AuthError(
          "auth_unavailable",
          "Sign-in is unavailable. Try again.",
          503,
        );
      return navigation(result.data.url);
    };
    let response: Response;
    try {
      response = await perform();
    } catch (error) {
      const failure =
        error instanceof AuthError || error instanceof StoreError
          ? error
          : new AuthError(
              "auth_unavailable",
              "Sign-in is unavailable. Try again.",
              503,
            );
      response = page(
        "Unable to continue",
        `<p>${e(failure.message)}</p>`,
        failure.status,
      );
    }
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers });
  };
}
