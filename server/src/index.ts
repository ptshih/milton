import { hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { RuntimeConfig } from "./config";
import { allowedHosts, createMiltonHandler, withMcpCors } from "./handler";
import { browserPages } from "./auth";
import { boundRequest } from "./http";

export function createMiltonApp(config: RuntimeConfig) {
  const mcp = createMiltonHandler(config);
  const pages = browserPages(config);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return mcp(request);
    const hostRefusal = hostHeaderValidationResponse(
      request,
      allowedHosts(config),
    );
    if (hostRefusal) return hostRefusal;
    if (path === "/health")
      return request.method === "GET"
        ? Response.json(
            { status: "ok" },
            { headers: { "Cache-Control": "no-store" } },
          )
        : new Response(null, { status: 405 });
    if (
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ].includes(path)
    ) {
      if (request.method === "OPTIONS")
        return withMcpCors(new Response(null, { status: 200 }), "GET, OPTIONS");
      if (request.method !== "GET")
        return withMcpCors(new Response(null, { status: 405 }), "GET, OPTIONS");
      return withMcpCors(
        Response.json({
          resource: config.resource,
          authorization_servers: [config.issuer],
          bearer_methods_supported: ["header"],
        }),
        "GET, OPTIONS",
      );
    }
    const resourceHost = new URL(config.resource).host;
    const url = new URL(request.url);
    // The MCP host serves assistants only; people use the app host.
    if (
      url.host === resourceHost &&
      new URL(config.appOrigin).host !== resourceHost
    )
      return Response.redirect(
        config.appOrigin + url.pathname + url.search,
        308,
      );
    const bounded = await boundRequest(request);
    return bounded instanceof Response ? bounded : pages(bounded);
  };
}
