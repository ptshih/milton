import { escapeHtml as e, page } from "./pages";
import type { PersonStore } from "./store";

export const isMemoRoute = (path: string) =>
  path === "/" ||
  path === "/download" ||
  path === "/memos" ||
  path.startsWith("/memos/") ||
  path === "/tps-report" ||
  path.startsWith("/tps-report/");

export async function memoPages(
  request: Request,
  store: Pick<PersonStore, "readTpsReport">,
  csrf: () => string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (
    !["/", "/tps-report", "/download"].includes(path) ||
    request.method === "POST"
  )
    return page("Not found", "<p>This page does not exist.</p>", 404);
  if (request.method !== "GET") return page("Method not allowed", "", 405);
  const report = await store.readTpsReport();
  if (path === "/download")
    return new Response(report.text, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="TPS.md"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  const guidance = report.is_empty
    ? '<aside class="guidance"><h2>No instructions on file.</h2><p>Ask your connected assistant to help you put your working instructions into words. It can start with instructions you’ve already shared, or ask a few useful questions.</p><p>Review and approve the complete draft before it saves anything. Milton will file the memos and prepare your TPS Report. You can also leave it empty.</p></aside>'
    : '<aside class="guidance"><p>To add or change instructions, tell your connected assistant what to save with Milton. Milton keeps the memos organized and prepares this report.</p></aside>';
  return page(
    "TPS Report",
    `<nav aria-label="Report"><a href="/download">Download TPS.md</a></nav><article class="sheet tps-sheet" aria-label="TPS Report"><div class="sheet-bar">Memo cover sheet</div><header class="tps-title"><h1>TPS Report</h1><p class="cover-subtitle">Your working instructions</p></header><div class="document-body${report.is_empty ? " empty" : ""}">${report.is_empty ? '<p class="empty-placeholder">No instructions on file.</p>' : `<pre class="memo-text">${e(report.text)}</pre>`}</div><div class="document-end" aria-hidden="true"></div></article>${guidance}<form class="signout" method="post" action="/logout">${csrf()}<button class="secondary">Sign out</button></form><p class="small-note">Signing out of this browser does not disconnect your assistants.</p>`,
    200,
    "",
    "tps",
  );
}
