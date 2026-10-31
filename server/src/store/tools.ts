import type { CreateInput, UpdateInput, ArchiveInput } from "./writes";
import type { ToolResult } from "../tools";
import {
  StoreError,
  TPS_REPORT_KEY,
  tpsReportSnapshot,
  type TenantStore,
} from "./index";
import { isTpsReportTemplate } from "../tps-check";

export function storeResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

export function createStoreMemoTools(store: TenantStore) {
  async function run(operation: () => Promise<ToolResult>) {
    try {
      return await operation();
    } catch (error) {
      return storeResult(
        {
          ...(error instanceof StoreError ? error.details : {}),
          error: error instanceof StoreError ? error.code : "store_unavailable",
          message:
            error instanceof StoreError
              ? error.message
              : "The memo store is unavailable. Try again.",
        },
        true,
      );
    }
  }
  return {
    create_memo(input: CreateInput) {
      return run(async () => storeResult(await store.createMemo(input)));
    },
    update_memo(input: UpdateInput) {
      return run(async () => storeResult(await store.updateMemo(input)));
    },
    update_tps_report(input: Omit<UpdateInput, "name">) {
      return run(async () =>
        storeResult(tpsReportSnapshot(await store.updateTpsReport(input))),
      );
    },
    archive_memo(input: ArchiveInput) {
      return run(async () => {
        const { name, version, archived } = await store.archiveMemo(input);
        return storeResult({ name, version, archived });
      });
    },
    list_memos(cursor?: string) {
      return run(async () => {
        const page = await store.listMemos(cursor);
        return storeResult({
          memos: page.items,
          next_cursor: page.next_cursor,
        });
      });
    },
    get_memo(name: string) {
      return run(async () => {
        if (name === TPS_REPORT_KEY)
          throw new StoreError(
            "tps_report_required",
            "Use get_tps_report to read TPS Report.",
            422,
          );
        const memo = await store.getMemo(name);
        return memo && !memo.archived
          ? storeResult(memo)
          : storeResult(
              { error: "not_found", message: "This memo does not exist." },
              true,
            );
      });
    },
    get_tps_report() {
      return run(async () => {
        const memo = await store.getTpsReport();
        return storeResult({
          ...tpsReportSnapshot(memo),
          is_template: isTpsReportTemplate(memo.text),
        });
      });
    },
    search(words: string, cursor?: string) {
      return run(async () => {
        const page = await store.search(words, cursor);
        return storeResult({
          matches: page.items,
          next_cursor: page.next_cursor,
        });
      });
    },
  };
}
