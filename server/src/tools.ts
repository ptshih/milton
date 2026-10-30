import type { Recipe } from "./recipes";

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

export interface ReadRecipeTools {
  list_recipes(cursor?: string): ToolResult | Promise<ToolResult>;
  get_recipe(name: string): ToolResult | Promise<ToolResult>;
  get_vibes(): ToolResult | Promise<ToolResult>;
  search(words: string, cursor?: string): ToolResult | Promise<ToolResult>;
}

export function createRecipeTools(recipes: readonly Recipe[]) {
  function result(text: string, isError = false): ToolResult {
    return {
      content: [{ type: "text", text }],
      ...(isError ? { isError } : {}),
    };
  }

  return {
    list_recipes() {
      return result(
        JSON.stringify(
          recipes.map(({ name, description }) => ({ name, description })),
        ),
      );
    },
    get_recipe(name: string) {
      const recipe = recipes.find((recipe) => recipe.name === name);
      return result(
        recipe?.text ??
          `Unknown recipe "${name}". Available recipes: ${recipes.map((recipe) => recipe.name).join(", ") || "none"}.`,
        !recipe,
      );
    },
    get_vibes() {
      return result(
        recipes.find((recipe) => recipe.name === "vibes")?.text ??
          "The vibes recipe is not published yet.",
      );
    },
    search(words: string) {
      const query = words.trim().toLowerCase();
      if (!query || query.length > 256)
        return result("Enter between 1 and 256 characters to search.", true);
      const matches = recipes.flatMap((recipe) => {
        const text = recipe.text.toLowerCase();
        const snippets: string[] = [];
        let offset = 0;
        while (snippets.length < 3) {
          const index = text.indexOf(query, offset);
          if (index === -1) break;
          const start = Math.max(0, index - 60);
          const end = Math.min(recipe.text.length, index + query.length + 60);
          snippets.push(
            `${start ? "…" : ""}${recipe.text.slice(start, end)}${end < recipe.text.length ? "…" : ""}`,
          );
          offset = index + query.length;
        }
        return snippets.length ? [{ name: recipe.name, snippets }] : [];
      });
      return result(JSON.stringify(matches));
    },
  };
}
