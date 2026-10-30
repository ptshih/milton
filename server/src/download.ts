import { zipSync } from "fflate";
import { StoreError, type RecipeSnapshot } from "./store";

export function recipeArchive(recipes: readonly RecipeSnapshot[]) {
  const files: Record<string, Uint8Array> = Object.create(null);
  const encode = (text: string) => new TextEncoder().encode(text);
  let bytes = 0;
  for (const recipe of recipes) {
    if (recipe.archived) continue;
    files[`${recipe.name}/SKILL.md`] = encode(
      `---\nname: ${JSON.stringify(recipe.name)}\ndescription: ${JSON.stringify(recipe.description)}\n---\n${recipe.text}`,
    );
    bytes += files[`${recipe.name}/SKILL.md`]!.length;
    if (recipe.name === "vibes") {
      files["VIBES.md"] = encode(recipe.text);
      bytes += files["VIBES.md"].length;
    }
    if (bytes > 4_000_000)
      throw new StoreError(
        "download_too_large",
        "The download exceeds its size limit.",
        422,
      );
  }
  const archive = zipSync(files, { level: 0 });
  if (archive.byteLength > 4_000_000)
    throw new StoreError(
      "download_too_large",
      "The download exceeds its size limit.",
      422,
    );
  return archive;
}

export function downloadResponse(recipes: readonly RecipeSnapshot[]) {
  return new Response(recipeArchive(recipes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="milton-recipes.zip"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
