// The local servers mirror Vercel's built static assets, with an exact allowlist.
const assets: Record<string, string> = {
  "/milton.css": "text/css; charset=utf-8",
  "/favicon.svg": "image/svg+xml",
  "/fonts/source-serif-4-semibold.woff2": "font/woff2",
  "/fonts/jetbrains-mono-regular.woff2": "font/woff2",
};

export function localAsset(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (!Object.hasOwn(assets, path)) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(
    request.method === "HEAD"
      ? null
      : Bun.file(new URL(`../public${path}`, import.meta.url)),
    {
      headers: {
        "Content-Type": assets[path]!,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
