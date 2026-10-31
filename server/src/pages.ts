import { AuthError } from "./token";
import { isLoopback } from "./config";
import { folderMark } from "@milton/theme/brand";

export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function page(
  title: string,
  content: string,
  status = 200,
  head = "",
  layout: "narrow" | "memo" | "tps" = "narrow",
) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Milton</title><link rel="stylesheet" href="/milton.css">${head}</head><body><a class="skip-link" href="#main">Skip to content</a><div class="app-shell ${layout}"><header class="app-header"><a class="brand" href="/" aria-label="Milton home">${folderMark}<span>Milton</span></a></header><main id="main" tabindex="-1">${layout === "tps" ? "" : `<h1>${escapeHtml(title)}</h1>`}${content}</main></div></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; font-src 'self'; connect-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
export function navigation(target: string) {
  let url: URL;
  try {
    url = new URL(target);
    if (
      url.username ||
      url.password ||
      /[\r\n]/.test(target) ||
      ["javascript:", "data:", "vbscript:", "file:", "blob:"].includes(
        url.protocol,
      ) ||
      (url.protocol === "http:" && !isLoopback(url.hostname))
    )
      throw new Error();
  } catch {
    throw new AuthError(
      "auth_unavailable",
      "The sign-in destination is unavailable. Restart from your assistant.",
      503,
    );
  }
  const href = escapeHtml(url.href);
  // A new document navigates after POST. No external Location redirect follows
  // a form restricted by form-action 'self' (Chromium/Safari handle that differently).
  return page(
    "Continue",
    `<p>Continuing your sign-in.</p><p><a href="${href}">Continue</a></p>`,
    200,
    `<meta http-equiv="refresh" content="0;url=${href}">`,
  );
}
