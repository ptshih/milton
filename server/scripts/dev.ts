import entry from "../api/index";
import { localAsset } from "./assets";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Set PORT to an available local port.");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const asset = localAsset(request);
    if (asset) return asset;
    return entry.fetch(request);
  },
});
console.log(`Milton local server listening on localhost:${server.port}.`);
