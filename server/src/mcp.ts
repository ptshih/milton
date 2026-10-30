import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Recipe } from "./recipes";
import { createRecipeTools, type ReadRecipeTools } from "./tools";
import { StoreError, type TenantStore } from "./store";
import { createStoreRecipeTools, storeResult } from "./store/tools";

import { createInput, updateInput, archiveInput } from "./store/writes";

export const storeInstructions =
  "Before writing anything for or as the person, call get_vibes and the recipe that fits the task. When the person states a durable preference, save it with update_recipe and say what you changed. After a conflict or a person’s revert, read the current recipe before attempting another write.";

export interface ToolCall {
  client: string;
  tool: string;
}

export function createMiltonServer(
  recipes: readonly Recipe[],
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
                      message: "The recipe store is unavailable. Try again.",
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
        : "Before writing anything for or as Peter, call get_vibes and the recipe that fits the task.",
    },
  );
  const tools: ReadRecipeTools = store
    ? createStoreRecipeTools(store)
    : createRecipeTools(recipes);
  const pageInput = z.object({ cursor: z.string().max(2048).optional() });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  server.registerTool(
    "list_recipes",
    {
      description: store
        ? "List active recipe names, descriptions and versions, with a continuation cursor."
        : "List the name and description of every published recipe.",
      inputSchema: store ? pageInput : z.object({}),
      annotations,
    },
    async (args) => tools.list_recipes(pageInput.parse(args).cursor),
  );
  server.registerTool(
    "get_recipe",
    {
      description: "Read a complete recipe by name.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(store ? 64 : 128),
      }),
      annotations,
    },
    async ({ name }) => tools.get_recipe(name),
  );
  server.registerTool(
    "get_vibes",
    {
      description: store
        ? "Read your active vibes recipe and its version."
        : "Read Peter's vibes recipe, or learn that it is not published yet.",
      inputSchema: z.object({}),
      annotations,
    },
    async () => tools.get_vibes(),
  );
  server.registerTool(
    "search",
    {
      description:
        "Find a literal phrase across recipes, ignoring case. Return up to three short snippets per recipe.",
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
    const writes = createStoreRecipeTools(store);
    const mutating = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    };
    server.registerTool(
      "create_recipe",
      {
        description:
          "Create a recipe at version 1. An existing name is a conflict.",
        inputSchema: createInput,
        annotations: mutating,
      },
      async (args) => writes.create_recipe(args),
    );
    server.registerTool(
      "update_recipe",
      {
        description:
          "Save a new version using the expected version tag from a read. A conflict returns the current recipe.",
        inputSchema: updateInput,
        annotations: mutating,
      },
      async (args) => writes.update_recipe(args),
    );
    server.registerTool(
      "archive_recipe",
      {
        description:
          "Archive a recipe using the expected version tag from a read.",
        inputSchema: archiveInput,
        annotations: mutating,
      },
      async (args) => writes.archive_recipe(args),
    );
  }
  return server;
}
