import type { CreateInput, UpdateInput, ArchiveInput } from "./writes";
import type { ToolResult } from "../tools";
import { StoreError, type TenantStore } from "./index";

export function storeResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError } : {}),
  };
}

export function createStoreRecipeTools(store: TenantStore) {
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
              : "The recipe store is unavailable. Try again.",
        },
        true,
      );
    }
  }
  return {
    create_recipe(input: CreateInput) {
      return run(async () => storeResult(await store.createRecipe(input)));
    },
    update_recipe(input: UpdateInput) {
      return run(async () => storeResult(await store.updateRecipe(input)));
    },
    archive_recipe(input: ArchiveInput) {
      return run(async () => storeResult(await store.archiveRecipe(input)));
    },
    list_recipes(cursor?: string) {
      return run(async () => {
        const page = await store.listRecipes(cursor);
        return storeResult({
          recipes: page.items,
          next_cursor: page.next_cursor,
        });
      });
    },
    get_recipe(name: string) {
      return run(async () => {
        const recipe = await store.getRecipe(name);
        return recipe
          ? storeResult(recipe)
          : storeResult(
              { error: "not_found", message: "This recipe does not exist." },
              true,
            );
      });
    },
    get_vibes() {
      return run(async () =>
        storeResult(
          (await store.getVibes()) ?? {
            recipe: null,
            message: "No active vibes recipe is available.",
          },
        ),
      );
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
