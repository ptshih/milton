import type { StoreBindings } from "./store";
import { StoreError } from "./store/errors";

export interface RuntimeConfig extends StoreBindings {
  issuer: string;
  resource: string;
  appOrigin: string;
  cookieSecret: string;
}
export const isLoopback = (hostname: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  try {
    const app = new URL(env.APP_ORIGIN!);
    const issuer = new URL(env.NEON_AUTH_BASE_URL!);
    const resource = new URL(env.MCP_RESOURCE!);
    const valid = (url: URL) =>
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          isLoopback(url.hostname)));
    if (
      !valid(app) ||
      !valid(issuer) ||
      !valid(resource) ||
      app.href !== app.origin + "/" ||
      resource.pathname !== "/mcp" ||
      issuer.href.endsWith("/") ||
      !env.NEON_AUTH_COOKIE_SECRET ||
      env.NEON_AUTH_COOKIE_SECRET.length < 32 ||
      (env.MEMOS_SOURCE && env.MEMOS_SOURCE !== "store")
    )
      throw new Error();
    return {
      issuer: issuer.href,
      resource: resource.href,
      appOrigin: app.origin,
      cookieSecret: env.NEON_AUTH_COOKIE_SECRET,
      DATABASE_URL: env.DATABASE_URL,
      MEMOS_SOURCE: "store",
    };
  } catch {
    throw new StoreError(
      "configuration",
      "Milton's server configuration is unavailable.",
    );
  }
}
