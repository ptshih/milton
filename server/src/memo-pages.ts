import { escapeHtml as e, page as renderPage } from "./pages";
import {
  StoreError,
  TPS_REPORT_KEY,
  type PersonStore,
  type MemoSnapshot,
  type VersionMetadata,
} from "./store";
import { parseVersionTag } from "./store/versions";
import { downloadResponse } from "./download";

const page = (
  title: string,
  content: string,
  status = 200,
  layout: "memo" | "tps" = "memo",
) => renderPage(title, content, status, "", layout);

export const isMemoRoute = (path: string) =>
  path === "/" ||
  path === "/memos" ||
  path.startsWith("/memos/") ||
  path === "/download" ||
  path === "/tps-report" ||
  path.startsWith("/tps-report/");
type Fields = Record<string, string>;
type Names = (
  actors: Record<string, unknown>[],
) => Promise<Map<string, string>>;
const pathFor = (name: string) =>
  name === TPS_REPORT_KEY
    ? "/tps-report"
    : `/memos/${encodeURIComponent(name)}`;
const titleFor = (memo: MemoSnapshot) =>
  memo.name === TPS_REPORT_KEY ? "TPS Report" : memo.name;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${e(value)}">`;
const numberOf = (memo: Pick<MemoSnapshot, "version">) =>
  parseVersionTag(memo.version)!.number;
const fence = (memo: MemoSnapshot) =>
  hidden("expected_version", memo.version) +
  hidden("memo_id", parseVersionTag(memo.version)!.id);
const resultMessages: Record<string, string> = {
  archived: "Your memo is archived.",
  restored: "Your memo is restored.",
  reverted: "Restored as a new version. Earlier versions are kept.",
};
const status = (url: URL, core = false) => {
  const result = url.searchParams.get("result") ?? "";
  return Object.hasOwn(resultMessages, result)
    ? core && result === "reverted"
      ? "TPS Report restored as a new version. Earlier versions are kept."
      : resultMessages[result]!
    : "";
};
const nav =
  '<nav aria-label="Memos"><a href="/">Your memos</a><a href="/tps-report">TPS Report</a><a href="/?archived=1">Archived</a><a href="/download">Download all</a></nav>';

function document(memo: MemoSnapshot, heading: "h1" | "h2" = "h1") {
  const core = memo.name === TPS_REPORT_KEY;
  return `<article class="sheet ${core ? "tps-sheet" : "memo-view"}" aria-label="${e(titleFor(memo))}"><div class="sheet-bar">${core ? "Core memo" : "Memo"}</div>${core ? `<header class="tps-title"><${heading}>TPS Report</${heading}><p class="cover-subtitle">Cover sheet</p></header>` : ""}<dl class="memo-metadata"><div><dt>Version</dt><dd>${numberOf(memo)}</dd></div><div><dt>Status</dt><dd>${memo.archived ? "Archived" : "Active"}</dd></div>${memo.description ? `<div class="description"><dt>Description</dt><dd>${e(memo.description)}</dd></div>` : ""}</dl><div class="document-body${memo.text ? "" : " empty"}">${memo.text ? `<pre class="memo-text">${e(memo.text)}</pre>` : `<p class="empty-placeholder">${core ? "No instructions on file." : "This memo is empty."}</p>`}</div><div class="document-end" aria-hidden="true"></div></article>`;
}

function viewer(
  csrf: () => string,
  memo: MemoSnapshot,
  message = "",
  code = 200,
  failed = false,
) {
  const core = memo.name === TPS_REPORT_KEY;
  const action = (verb: string, label: string, explanation: string) =>
    `<details class="memo-action"><summary>${label}</summary><p>${explanation}</p><form method="post" enctype="multipart/form-data" action="${pathFor(memo.name)}/${verb}">${csrf()}${fence(memo)}<button class="secondary">${label}</button></form></details>`;
  const controls = core
    ? ""
    : memo.archived
      ? action(
          "restore",
          "Restore memo",
          "Restoring returns this memo to your active memos, available for assistants to read. Its history stays available.",
        )
      : action(
          "archive",
          "Archive memo",
          "Archiving stops serving this memo to assistants. Its content and history stay available. You can restore it from Archived. Archiving can be refused at your daily write or retained-history limit. The history limit does not reset daily.",
        );
  const guidance = core
    ? memo.text
      ? '<aside class="guidance"><p>To change these instructions, ask your connected assistant to update your TPS Report.</p><p class="small-note">Your permanent core memo. Included as TPS.md in Download all.</p></aside>'
      : '<aside class="guidance"><h2>Your TPS Report is empty.</h2><p>Ask your connected assistant to draft your TPS Report using working preferences you’ve shared with it. It can ask useful follow-up questions. If it has no preferences to start from, it can begin with questions.</p><p>Approve the complete draft before it saves anything. You can also leave your TPS Report empty.</p><p class="small-note">New accounts start with only an empty TPS Report. Your assistant can create other memos when you need them.</p></aside>'
    : `<aside class="guidance"><p>${memo.archived ? "Restore this memo first, then ask your connected assistant to update its instructions." : "To change these instructions, ask your connected assistant to update this memo."}</p></aside>`;
  return page(
    titleFor(memo),
    `${nav}${message ? `<p role="${failed ? "alert" : "status"}">${e(message)}</p>` : ""}<div class="topline"><p>${core ? "Permanent core memo" : "Your instructions, in writing"}</p><a href="${pathFor(memo.name)}/history">Version history</a></div>${memo.archived ? '<aside class="archive-status"><strong>Archived memo</strong><p>This memo is not served to assistants. Its content and history are kept.</p></aside>' : ""}${document(memo)}${guidance}${controls}`,
    code,
    core ? "tps" : "memo",
  );
}

function author(version: VersionMetadata, names: Map<string, string>) {
  const actor = version.actor;
  if (actor.kind === "person") return "You";
  if (actor.kind === "assistant" && typeof actor.client_id === "string")
    return (
      names.get(String(actor.issuer) + "\0" + actor.client_id) ??
      actor.client_id
    );
  if (actor.kind === "system" && actor.id === "template-seed")
    return "Initial template";
  if (
    actor.kind === "import" ||
    actor.kind === "person-import" ||
    actor.id === "memo-import" ||
    actor.id === "recipe-import"
  )
    return "Memo import";
  return "System / imported version";
}

function plainDiff(previous: MemoSnapshot | null, selected: MemoSnapshot) {
  const lines = (memo: MemoSnapshot | null) =>
    memo
      ? [
          `Description: ${memo.description}`,
          `Archived: ${memo.archived}`,
          ...memo.text.split("\n"),
        ]
      : [];
  const before = lines(previous),
    after = lines(selected);
  let start = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (
    start < endBefore &&
    start < endAfter &&
    before[start] === after[start]
  )
    start++;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  return (
    [
      ...before.slice(start, endBefore).map((line) => `− ${line}`),
      ...after.slice(start, endAfter).map((line) => `+ ${line}`),
    ].join("\n") || "No text or archive changes."
  );
}

export async function memoPages(
  request: Request,
  store: PersonStore,
  csrf: () => string,
  names: Names,
  form?: Fields,
): Promise<Response> {
  const url = new URL(request.url);
  const coreMatch =
    /^\/tps-report(?:\/(history|revert)(?:\/([1-9][0-9]{0,9}))?)?$/.exec(
      url.pathname,
    );
  const ordinaryMatch =
    /^\/memos\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(history|archive|restore|revert)(?:\/([1-9][0-9]{0,9}))?)?$/.exec(
      url.pathname,
    );
  const match = coreMatch
    ? [coreMatch[0], TPS_REPORT_KEY, coreMatch[1], coreMatch[2]]
    : ordinaryMatch;
  if (ordinaryMatch?.[1] === TPS_REPORT_KEY) return page("Not found", nav, 404);
  if (request.method === "POST") {
    if (
      !match ||
      !["archive", "restore", "revert"].includes(match[2] ?? "") ||
      match[3]
    )
      return page("Not found", nav, 404);
    const name = match[1]!;
    const action = match[2]!;
    const read = () => (coreMatch ? store.getTpsReport() : store.getMemo(name));
    try {
      const submitted = form!;
      const allowed = [
        "csrf",
        "memo_id",
        "expected_version",
        ...(action === "revert" ? ["source_version"] : []),
      ];
      if (Object.keys(submitted).some((key) => !allowed.includes(key)))
        throw new StoreError(
          "invalid_input",
          "Check the memo fields and try again.",
          400,
        );
      const tag = parseVersionTag(submitted.expected_version ?? "");
      if (!tag || submitted.memo_id !== tag.id)
        throw new StoreError(
          "memo_version_conflict",
          "Read the current memo before trying another write.",
          409,
        );
      const input = { name, expected_version: submitted.expected_version! };
      if (action === "archive")
        await store.archiveMemo({ ...input, reason: "Archived memo" });
      else if (action === "restore") await store.restoreMemo(input);
      else {
        const source = submitted.source_version ?? "";
        if (!/^[1-9][0-9]{0,9}$/.test(source) || Number(source) > 2147483647)
          throw new StoreError(
            "invalid_input",
            "Choose a stored version to restore.",
            400,
          );
        await store.revertMemo({ ...input, source_version: Number(source) });
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location:
            pathFor(name) +
            "?result=" +
            { archive: "archived", restore: "restored", revert: "reverted" }[
              action
            ],
        },
      });
    } catch (error) {
      const failure =
        error instanceof StoreError
          ? error
          : new StoreError(
              "store_unavailable",
              "The write outcome is unavailable. Read the current memo before retrying.",
            );
      try {
        const latest = await read();
        if (!latest)
          return page(
            "Not found",
            `${nav}<p role="alert">This memo does not exist.</p>`,
            404,
          );
        return viewer(csrf, latest, failure.message, failure.status, true);
      } catch {
        return page(
          coreMatch ? "TPS Report unavailable" : "Memo unavailable",
          `${nav}<p role="alert">${e(failure.message)} The current version could not be read. Reload before trying another action.</p>`,
          503,
        );
      }
    }
  }
  if (request.method !== "GET") return page("Method not allowed", nav, 405);
  if (url.pathname === "/download") {
    await store.getTpsReport();
    return downloadResponse(await store.downloadMemos());
  }
  if (url.pathname === "/") {
    const archived = url.searchParams.get("archived") === "1";
    const tps = await store.getTpsReport();
    const [memos, usage] = await Promise.all([
      store.listMemos(
        url.searchParams.get("cursor") ?? undefined,
        archived,
        true,
      ),
      store.usage(),
    ]);
    return page(
      "Your TPS Report",
      `${nav}${status(url) ? `<p role="status">${e(status(url))}</p>` : ""}<div class="sheet"><div class="sheet-bar">Permanent core memo</div><ul class="memo-list"><li><div class="row-heading"><a href="/tps-report">View TPS Report</a><span>Version ${numberOf(tps)}</span></div><p>${e(tps.description) || "Your working preferences, ready when you are."}</p></li></ul></div><section><h2>${archived ? "Archived memos" : "Your memos"}</h2>${memos.items.length ? `<ul class="memo-list sheet">${memos.items.map((memo) => `<li><div class="row-heading"><a href="${pathFor(memo.name)}">${e(memo.name)}</a><span>Version ${numberOf(memo)}</span></div><p>${e(memo.description)}</p></li>`).join("")}</ul>` : archived ? "<p>No archived memos.</p>" : "<p>No other memos yet.</p><p>Ask your connected assistant to create a memo for something you do your way.</p>"}${memos.next_cursor ? `<a class="pagination" href="/?${archived ? "archived=1&amp;" : ""}cursor=${encodeURIComponent(memos.next_cursor)}">Older memos</a>` : ""}</section><section class="usage"><h2>Usage</h2><p>${usage.memos} / ${usage.limits.memos} memos · ${usage.writes} / ${usage.limits.daily_writes} writes today · ${usage.tool_calls} / ${usage.limits.daily_calls} assistant calls today.</p><p>${usage.retained_bytes} / ${usage.limits.history_bytes} bytes of retained history. Daily caps reset at midnight UTC.</p></section><form class="signout" method="post" action="/logout">${csrf()}<button class="secondary">Sign out</button></form><p class="small-note">Signing out of this browser does not disconnect your assistants.</p>`,
    );
  }
  if (
    !match ||
    (match[3] && match[2] !== "history") ||
    (match[2] && match[2] !== "history")
  )
    return page("Not found", nav, 404);
  const memo =
    match[1] === TPS_REPORT_KEY
      ? await store.getTpsReport()
      : await store.getMemo(match[1]!);
  if (!memo)
    return page("Not found", `${nav}<p>This memo does not exist.</p>`, 404);
  if (!match[2]) return viewer(csrf, memo, status(url, Boolean(coreMatch)));
  if (!match[3]) {
    const versions = await store.history(
      memo.name,
      url.searchParams.get("cursor") ?? undefined,
    );
    const labels = await names(versions.items.map((version) => version.actor));
    return page(
      `${titleFor(memo)}: version history`,
      `${nav}<p><a href="${pathFor(memo.name)}">Back to ${e(titleFor(memo))}</a></p><ol class="history">${versions.items.map((version) => `<li><a href="${pathFor(memo.name)}/history/${version.version}">Version ${version.version}</a><p>${e(author(version, labels))} · <time>${e(version.created_at)}</time></p><p>${e(version.reason)}</p></li>`).join("")}</ol>${versions.next_cursor ? `<a href="${pathFor(memo.name)}/history?cursor=${versions.next_cursor}">Older versions</a>` : ""}`,
    );
  }
  const number = Number(match[3]);
  if (number > 2147483647) return page("Not found", nav, 404);
  const [selected, previous] = await Promise.all([
    store.getVersion(memo.name, number),
    number > 1 ? store.getVersion(memo.name, number - 1) : null,
  ]);
  if (!selected) return page("Not found", nav, 404);
  const labels = await names([selected.metadata.actor]);
  return page(
    `${titleFor(memo)}: version ${number}`,
    `${nav}<p><a href="${pathFor(memo.name)}/history">Version history</a></p><p>${e(author(selected.metadata, labels))} · ${e(selected.metadata.created_at)}</p><p>${e(selected.metadata.reason)}</p><h2>Stored ${coreMatch ? "TPS Report" : "memo"}</h2>${document(selected, "h2")}<h2>${number > 1 ? `Changes from version ${number - 1}` : "Initial version"}</h2><pre class="diff">${e(plainDiff(previous, selected))}</pre><form method="post" enctype="multipart/form-data" action="${pathFor(memo.name)}/revert">${csrf()}${fence(memo)}${hidden("source_version", String(number))}<p>Restoration creates a new version and keeps earlier versions. The stored version is not edited. ${coreMatch ? "The restored TPS Report stays active." : `The restored memo will be ${selected.archived ? "archived" : "active"}.`}</p><button>Restore this version</button></form>`,
  );
}
