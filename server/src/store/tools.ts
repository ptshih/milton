import type { ToolResult } from "../tools";
import { StoreError, type TenantStore } from "./index";
import type { SaveMemoInput } from "./compiled";

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
              : "Milton is unavailable. No save outcome is confirmed.",
        },
        true,
      );
    }
  }
  return {
    get_tps_report: () =>
      run(async () => storeResult(await store.readTpsReport())),
    save_memo: (input: SaveMemoInput) =>
      run(async () => {
        const outcome = await store.saveMemo(input);
        return storeResult(
          outcome,
          outcome.status === "failed" || outcome.status === "conflict",
        );
      }),
  };
}
