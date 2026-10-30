import entry from "../api/index";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Set PORT to an available local port.");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (new URL(request.url).pathname === "/milton.css")
      return new Response(
        Bun.file(new URL("../public/milton.css", import.meta.url)),
        { headers: { "Content-Type": "text/css; charset=utf-8" } },
      );
    return entry.fetch(request);
  },
});
console.log(`Milton local server listening on localhost:${server.port}.`);
