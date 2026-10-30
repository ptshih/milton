import { expect, test } from "bun:test";
import { recipeArchive } from "../src/download";
import { unzipSync } from "fflate";
import { loadRecipes, parseRecipe } from "../src/recipes";

test("loads frontmatter and preserves the complete recipe without a duplicate body", async () => {
  const recipes = await loadRecipes(
    new URL("./fixtures/recipes/", import.meta.url),
  );
  expect(recipes).toHaveLength(1);
  expect(recipes[0]?.name).toBe("sample");
  expect(recipes[0]?.description).toBe(
    "A fixture: plain text with punctuation.",
  );
  expect(recipes[0]).not.toHaveProperty("body");
  expect(recipes[0]?.text).toEndWith(
    "\n# Sample\n\nWrite plainly. Keep the details useful.\n",
  );
  expect(recipes[0]?.text).toStartWith("---\nname: sample\n");
  expect(() => parseRecipe("sample", "No frontmatter")).toThrow("frontmatter");
  expect(() => parseRecipe("other", recipes[0]!.text)).toThrow("name");
});

test("frontmatter rejects block scalars and unclosed quoted fields, and preserves plain trailing quotes", () => {
  const source = (description: string) =>
    `---\nname: sample\ndescription: ${description}\n---\nBody\n`;
  for (const value of [
    ">",
    "|",
    ">-",
    "|-",
    ">+",
    "|+",
    ">2",
    "|2-",
    ">+2",
    "|-2",
    "'unclosed",
    '"unclosed',
    '"bad\\q"',
  ]) {
    expect(() => parseRecipe("sample", source(value))).toThrow(/sample:/);
  }
  expect(
    parseRecipe("sample", source('"A quoted description."')).description,
  ).toBe("A quoted description.");
  expect(parseRecipe("sample", source("'Peter''s recipe'")).description).toBe(
    "Peter's recipe",
  );
  for (const value of [
    "unopened'",
    'unopened"',
    'Use the sign-off "Best,"',
    "Use the sign-off 'Best,'",
  ]) {
    expect(parseRecipe("sample", source(value)).description).toBe(value);
  }
});

test("downloads quote YAML scalars and preserve bodies in portable ZIP entries", () => {
  const body = "\r\n# Café\r\n</textarea>\n";
  const recipes = ["true", "null", "123", "vibes"].map((name) => ({
    name,
    description: 'Quotes: "yes" and café',
    text: body,
    version: "unused",
    archived: false,
  }));
  const files = unzipSync(
    recipeArchive([
      ...recipes,
      { ...recipes[0]!, name: "archived", archived: true },
    ]),
  );
  expect(Object.keys(files).sort()).toEqual([
    "123/SKILL.md",
    "VIBES.md",
    "null/SKILL.md",
    "true/SKILL.md",
    "vibes/SKILL.md",
  ]);
  expect(new TextDecoder().decode(files["VIBES.md"])).toBe(body);
  for (const recipe of recipes) {
    const output = new TextDecoder().decode(files[recipe.name + "/SKILL.md"]);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(output)!;
    expect(Bun.YAML.parse(match[1]!)).toEqual({
      name: recipe.name,
      description: recipe.description,
    });
    expect(output.slice(match[0].length)).toBe(body);
  }
  expect(Object.keys(unzipSync(recipeArchive([])))).toEqual([]);
  expect(() =>
    recipeArchive([{ ...recipes[0]!, text: "x".repeat(4_000_001) }]),
  ).toThrow("download");
});
