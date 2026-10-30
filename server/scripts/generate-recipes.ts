import { mkdir, writeFile } from "node:fs/promises";
import { loadRecipes } from "../src/recipes";

await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
const templates = await loadRecipes(
  new URL("../../templates/", import.meta.url),
);
await writeFile(
  new URL("../generated/templates.json", import.meta.url),
  `${JSON.stringify(
    templates.map(({ name, description, text }) => ({
      name,
      description,
      body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
    })),
  )}\n`,
);
