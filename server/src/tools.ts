import type { Memo } from "./memos";
import { TPS_REPORT_KEY } from "./store";

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

export interface ReadMemoTools {
  list_memos(cursor?: string): ToolResult | Promise<ToolResult>;
  get_memo(name: string): ToolResult | Promise<ToolResult>;
  get_tps_report(): ToolResult | Promise<ToolResult>;
  search(words: string, cursor?: string): ToolResult | Promise<ToolResult>;
}

export function createMemoTools(memos: readonly Memo[]) {
  function result(text: string, isError = false): ToolResult {
    return {
      content: [{ type: "text", text }],
      ...(isError ? { isError } : {}),
    };
  }

  const ordinary = memos.filter(({ name }) => name !== TPS_REPORT_KEY);
  return {
    list_memos() {
      return result(
        JSON.stringify(
          ordinary.map(({ name, description }) => ({ name, description })),
        ),
      );
    },
    get_memo(name: string) {
      if (name === TPS_REPORT_KEY)
        return result("Use get_tps_report to read TPS Report.", true);
      const memo = ordinary.find((memo) => memo.name === name);
      return result(
        memo?.text ??
          `Unknown memo "${name}". Available memos: ${ordinary.map((memo) => memo.name).join(", ") || "none"}.`,
        !memo,
      );
    },
    get_tps_report() {
      const core = memos.find((memo) => memo.name === TPS_REPORT_KEY);
      return result(
        core
          ? JSON.stringify({
              title: "TPS Report",
              description: core.description,
              text: core.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
            })
          : "TPS Report is not published yet.",
      );
    },
    search(words: string) {
      const query = words.trim().toLowerCase();
      if (!query || query.length > 256)
        return result("Enter between 1 and 256 characters to search.", true);
      const matches = memos.flatMap<
        | {
            kind: "tps_report";
            title: string;
            description: string;
            snippets: string[];
          }
        | { kind: "memo"; name: string; snippets: string[] }
      >((memo) => {
        const core = memo.name === TPS_REPORT_KEY;
        const body = core
          ? memo.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
          : memo.text;
        const source = core ? `TPS Report\n${memo.description}\n${body}` : body;
        const text = source.toLowerCase();
        const snippets: string[] = [];
        let offset = 0;
        while (snippets.length < 3) {
          const index = text.indexOf(query, offset);
          if (index === -1) break;
          const start = Math.max(0, index - 60);
          const end = Math.min(source.length, index + query.length + 60);
          snippets.push(
            `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`,
          );
          offset = index + query.length;
        }
        return snippets.length
          ? [
              core
                ? {
                    kind: "tps_report",
                    title: "TPS Report",
                    description: memo.description,
                    snippets,
                  }
                : { kind: "memo", name: memo.name, snippets },
            ]
          : [];
      });
      return result(JSON.stringify(matches));
    },
  };
}
