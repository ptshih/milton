import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { createMiltonServer } from "./mcp";
import {
  guardStoreRequest,
  lookupIdentityAccount,
  storeForCurrentRequest,
  type StoreBindings,
  StoreError,
} from "./store";
import {
  AuthError,
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./token";
import { isLoopback } from "./config";
import { boundRequest } from "./http";

export interface McpConfig extends StoreBindings {
  issuer: string;
  resource: string;
  appOrigin: string;
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers":
    "WWW-Authenticate, mcp-session-id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
export function withMcpCors(response: Response, methods = "POST, OPTIONS") {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
export function allowedHosts(
  config: Pick<McpConfig, "resource" | "appOrigin">,
) {
  const hostnames = [
    new URL(config.resource).hostname,
    new URL(config.appOrigin).hostname,
  ];
  if (isLoopback(new URL(config.appOrigin).hostname))
    hostnames.push("localhost", "127.0.0.1", "[::1]");
  return hostnames;
}
export function validateMcpTransport(
  request: Request,
  config: Pick<McpConfig, "resource" | "appOrigin">,
) {
  if (!["POST", "OPTIONS"].includes(request.method))
    return withMcpCors(
      Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        },
        { status: 405, headers: { Allow: "POST, OPTIONS" } },
      ),
    );
  const hosts = allowedHosts(config);
  const refused =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, [...hosts, "claude.ai", "chatgpt.com"]);
  if (refused) return withMcpCors(refused);
  if (request.method === "OPTIONS")
    return withMcpCors(new Response(null, { status: 200 }));
  return null;
}
export function createMiltonHandler(
  config: McpConfig,
  verify: AccessTokenVerifier = createAccessTokenVerifier(config),
) {
  return async (request: Request): Promise<Response> => {
    const refusal = validateMcpTransport(request, config);
    if (refusal) return refusal;
    try {
      const bounded = await boundRequest(request);
      if (bounded instanceof Response) return withMcpCors(bounded);
      const identity = await verify(request.headers.get("Authorization"));
      const bindings = { ...config, MEMOS_SOURCE: "store" };
      const auth = await lookupIdentityAccount(bindings, {
        provider: "neon",
        subject: identity.subject,
      });
      const checked = await guardStoreRequest(bounded, bindings);
      if (checked instanceof Response) return withMcpCors(checked);
      const store = await storeForCurrentRequest(bindings, auth, {
        issuer: identity.issuer,
        clientId: identity.clientId,
      });
      const sdk = createMcpHandler(
        () => createMiltonServer([], () => identity.clientId, undefined, store),
        {
          legacy: "stateless",
          maxSubscriptions: 0,
          keepAliveMs: 0,
          maxRequestBodySize: 65536,
        },
      );
      return withMcpCors(await sdk.fetch(checked));
    } catch (error) {
      if (error instanceof AuthError || error instanceof StoreError) {
        const headers = new Headers();
        if (error.status === 401) {
          const invalid = request.headers.has("Authorization")
            ? ', error="invalid_token"'
            : "";
          headers.set(
            "WWW-Authenticate",
            `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", config.resource).href}"${invalid}`,
          );
        }
        return withMcpCors(
          Response.json(
            { error: error.code, message: error.message },
            { status: error.status, headers },
          ),
        );
      }
      return withMcpCors(
        Response.json(
          {
            error: "server_unavailable",
            message: "Milton is unavailable. Try again.",
          },
          { status: 503 },
        ),
      );
    }
  };
}
