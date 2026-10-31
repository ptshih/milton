import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Memo } from "./memos";
import { createMemoTools, type ReadMemoTools } from "./tools";
import { StoreError, type TenantStore } from "./store";
import { createStoreMemoTools, storeResult } from "./store/tools";

import {
  createInput,
  updateInput,
  updateTpsReportInput,
  archiveInput,
} from "./store/writes";
import { tpsCheckGuide } from "./tps-check";
import { checkDraftInput } from "./draft-check";

export const storeInstructions =
  "Before working for or as the person, call get_tps_report and a relevant ordinary memo. If get_tps_report returns is_template: true, TPS Report is not set up yet; if you have not offered TPS setup in this conversation, briefly offer it once. Do not repeat the offer if the person declines, skips it, or changes the subject. If they agree or ask for setup, call tps_check and follow its guide: use available explicit preferences first, ask useful follow-ups, and show the complete draft for approval before saving. Use the questionnaire when preferences are unavailable. Confirm only after a successful save; report failed, conflicting or uncertain outcomes honestly and never retry blindly. Do not offer setup when TPS Report is customized. Use update_tps_report for general working preferences and update_memo for task-specific instructions. After a conflict or a person’s restoration, read the current head before another write. Before showing a draft, call check_draft with its text and a relevant ordinary memo name when applicable, then check and revise it against the returned rules.";

export interface ToolCall {
  client: string;
  tool: string;
}

export function createMiltonServer(
  memos: readonly Memo[],
  client: () => string,
  log: (call: ToolCall) => void = (call) => console.info(JSON.stringify(call)),
  store?: TenantStore,
) {
  const server = new (class extends McpServer {
    override async connect(transport: Transport) {
      await super.connect(transport);
      const dispatch = transport.onmessage;
      transport.onmessage = async (message, extra) => {
        if ("method" in message && message.method === "tools/call") {
          const name = message.params?.name;
          log({
            client: client().slice(0, 80),
            tool: typeof name === "string" ? name.slice(0, 128) : "unknown",
          });
          if (store) {
            try {
              const allowance = await store.chargeToolCall();
              if (!allowance.allowed) {
                if ("id" in message)
                  await transport.send({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: storeResult(
                      {
                        error: "rate_limited",
                        limit: allowance.limit,
                        retry_at_ms: allowance.retry_at_ms,
                      },
                      true,
                    ),
                  });
                return;
              }
            } catch (error) {
              if ("id" in message)
                await transport.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: storeResult(
                    {
                      error:
                        error instanceof StoreError
                          ? error.code
                          : "store_unavailable",
                      message: "The memo store is unavailable. Try again.",
                    },
                    true,
                  ),
                });
              return;
            }
          }
        }
        dispatch?.(message, extra);
      };
    }
  })(
    { name: "Milton", version: "0.0.0" },
    {
      instructions: store
        ? storeInstructions
        : "Before working for or as the person, call get_tps_report and a relevant ordinary memo.",
    },
  );
  const tools: ReadMemoTools = store
    ? createStoreMemoTools(store)
    : createMemoTools(memos);
  const pageInput = z.object({ cursor: z.string().max(2048).optional() });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "list_memos",
    {
      description: store
        ? "List active ordinary memo names, descriptions and versions, with a continuation cursor."
        : "List the name and description of every published memo.",
      inputSchema: store ? pageInput : z.object({}),
      annotations,
    },
    async (args) => tools.list_memos(pageInput.parse(args).cursor),
  );
  server.registerTool(
    "get_memo",
    {
      description: "Read a complete active ordinary memo by name.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(store ? 64 : 128),
      }),
      annotations,
    },
    async ({ name }) => tools.get_memo(name),
  );
  server.registerTool(
    "get_tps_report",
    {
      description: store
        ? "Read TPS Report and its version, creating it if missing."
        : "Read the published TPS Report, or learn that it is not published yet.",
      inputSchema: z.object({}),
      annotations: store
        ? { ...annotations, readOnlyHint: false }
        : annotations,
    },
    async () => tools.get_tps_report(),
  );
  server.registerTool(
    "search",
    {
      description:
        "Find a literal phrase across memos, ignoring case. Return up to three short snippets per memo.",
      inputSchema: store
        ? z.object({
            words: z.string().trim().min(1).max(256),
            cursor: z.string().max(2048).optional(),
          })
        : z.object({ words: z.string().trim().min(1).max(256) }),
      annotations,
    },
    async (args) => tools.search(args.words, pageInput.parse(args).cursor),
  );
  if (store) {
    const storeTools = createStoreMemoTools(store);
    server.registerTool(
      "check_draft",
      {
        description:
          "Return a draft, TPS Report, an optional named active memo, and a review guide. The assistant judges the draft; Milton makes no model call and saves no draft or memo changes. Omit name for TPS-only coverage. Draft limit: 32 KiB UTF-8.",
        inputSchema: checkDraftInput,
        annotations,
      },
      async (args) => storeTools.check_draft(args),
    );
    server.registerTool(
      "tps_check",
      {
        description:
          "Return questions and drafting instructions for preparing TPS Report. This tool does not save changes.",
        inputSchema: z.object({}),
        annotations,
      },
      async () => ({ content: [{ type: "text", text: tpsCheckGuide }] }),
    );
    const mutating = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
    server.registerTool(
      "create_memo",
      {
        description:
          "Create a memo at version 1. An existing name is a conflict.",
        inputSchema: createInput,
        annotations: mutating,
      },
      async (args) => storeTools.create_memo(args),
    );
    server.registerTool(
      "update_memo",
      {
        description:
          "Save a new version using the expected version tag from a read. A conflict returns the current memo.",
        inputSchema: updateInput,
        annotations: mutating,
      },
      async (args) => storeTools.update_memo(args),
    );
    server.registerTool(
      "update_tps_report",
      {
        description:
          "Save TPS Report using its complete expected version tag. Empty text is valid.",
        inputSchema: updateTpsReportInput,
        annotations: mutating,
      },
      async (args) => storeTools.update_tps_report(args),
    );
    server.registerTool(
      "archive_memo",
      {
        description:
          "Archive a memo using the expected version tag from a read.",
        inputSchema: archiveInput,
        annotations: mutating,
      },
      async (args) => storeTools.archive_memo(args),
    );
  }
  return server;
}
