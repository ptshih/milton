import { escapeHtml as e, page } from "./pages";
import {
  StoreError,
  TPS_REPORT_KEY,
  type PersonStore,
  type MemoSnapshot,
  type VersionMetadata,
} from "./store";
import { parseVersionTag } from "./store/versions";
import { downloadResponse } from "./download";

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

function viewer(
  csrf: () => string,
  memo: MemoSnapshot,
  message = "",
  code = 200,
  failed = false,
) {
  const core = memo.name === TPS_REPORT_KEY;
  const action = (verb: string, label: string) =>
    `<form method="post" enctype="multipart/form-data" action="${pathFor(memo.name)}/${verb}">${csrf()}${fence(memo)}<button class="secondary">${label}</button></form>`;
  const controls = core
    ? ""
    : memo.archived
      ? action("restore", "Restore memo")
      : action("archive", "Archive memo");
  const guidance = core
    ? "<aside><h2>Working preferences</h2><p>Ask your connected assistant to read TPS Report and help draft your working preferences. It uses explicit preferences you provide, asks useful follow-ups, and shows the complete draft for approval before saving. If none are available, ask for a TPS check.</p></aside>"
    : `<p>${memo.archived ? "Restore this memo before asking your assistant to change it." : "Ask your connected assistant to change this memo."}</p>`;
  return page(
    titleFor(memo),
    `${nav}${message ? `<p role="${failed ? "alert" : "status"}">${e(message)}</p>` : ""}<article class="${core ? "tps-sheet" : "memo-view"}"><dl class="memo-metadata"><dt>Version</dt><dd>${numberOf(memo)}</dd><dt>Status</dt><dd>${memo.archived ? "Archived" : "Active"}</dd><dt>Description</dt><dd>${e(memo.description)}</dd></dl><p><a href="${pathFor(memo.name)}/history">Version history</a> · <a href="/download">Download all memos</a></p>${memo.text ? `<pre>${e(memo.text)}</pre>` : `<p>${core ? "TPS Report is empty." : "This memo is empty."}</p>`}</article>${guidance}${controls}`,
    code,
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
      "Your memos",
      `${nav}${status(url) ? `<p role="status">${e(status(url))}</p>` : ""}<ul class="memo-list"><li><a href="/tps-report">TPS Report</a><span>Version ${numberOf(tps)}</span><p>${e(tps.description)}</p></li></ul><section><h2>${archived ? "Archived memos" : "Your memos"}</h2>${memos.items.length ? `<ul class="memo-list">${memos.items.map((memo) => `<li><a href="${pathFor(memo.name)}">${e(memo.name)}</a><span>Version ${numberOf(memo)}</span><p>${e(memo.description)}</p></li>`).join("")}</ul>` : "<p>No memos here yet.</p>"}${memos.next_cursor ? `<a href="/?${archived ? "archived=1&amp;" : ""}cursor=${encodeURIComponent(memos.next_cursor)}">Older memos</a>` : ""}</section><section><h2>Usage</h2><p>${usage.memos} / ${usage.limits.memos} memos · ${usage.writes} / ${usage.limits.daily_writes} writes today · ${usage.tool_calls} / ${usage.limits.daily_calls} assistant calls today.</p><p>${usage.retained_bytes} / ${usage.limits.history_bytes} bytes of retained history. Daily caps reset at midnight UTC.</p></section><form method="post" action="/logout">${csrf()}<button class="secondary">Sign out</button></form><p>Signing out of this browser does not disconnect your assistants.</p>`,
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
    `${nav}<p><a href="${pathFor(memo.name)}/history">Version history</a></p><p>${e(author(selected.metadata, labels))} · ${e(selected.metadata.created_at)}</p><p>${e(selected.metadata.reason)}</p><h2>Stored ${coreMatch ? "TPS Report" : "memo"}</h2><p>${e(selected.description)} · ${selected.archived ? "Archived" : "Active"}</p><pre>${e(selected.text)}</pre><h2>${number > 1 ? `Changes from version ${number - 1}` : "Initial version"}</h2><pre>${e(plainDiff(previous, selected))}</pre><form method="post" enctype="multipart/form-data" action="${pathFor(memo.name)}/revert">${csrf()}${fence(memo)}${hidden("source_version", String(number))}<p>Restoration creates a new version and keeps earlier versions. ${coreMatch ? "The restored TPS Report stays active." : `The restored memo will be ${selected.archived ? "archived" : "active"}.`}</p><button>Restore this version</button></form>`,
  );
}
