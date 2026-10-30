import { runtimeConfig } from "./config";
import { createMiltonApp } from "./index";

let app: ReturnType<typeof createMiltonApp> | undefined;
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      app ??= createMiltonApp(runtimeConfig());
      return await app(request);
    } catch {
      return Response.json(
        {
          error: "server_unavailable",
          message: "Milton is unavailable. Try again.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
};
