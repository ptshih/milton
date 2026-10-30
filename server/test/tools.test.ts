import { expect, test } from "bun:test";
import { loadRecipes } from "../src/recipes";
import { createRecipeTools } from "../src/tools";

test("the four read tools serve only published recipes", async () => {
  const recipes = [
    ...(await loadRecipes(new URL("../../templates/", import.meta.url))),
    {
      name: "fixture-extra",
      description: "An additional fixture recipe.",
      text: "A third recipe.",
    },
  ];
  const tools = createRecipeTools(recipes);
  const list = tools.list_recipes();
  expect(list.isError).not.toBe(true);
  expect(JSON.parse(list.content[0]!.text)).toEqual(
    recipes.map(({ name, description }) => ({ name, description })),
  );
  const names = recipes.map((recipe) => recipe.name);
  expect(names).toContain("email-voice");
  expect(names).toContain("vibes");
  expect(tools.get_recipe("email-voice").content[0]!.text).toBe(
    recipes.find((recipe) => recipe.name === "email-voice")!.text,
  );
  const missing = tools.get_recipe("missing");
  expect(missing.isError).toBe(true);
  expect(missing.content[0]!.text).toContain(
    `Available recipes: ${names.join(", ")}`,
  );
  const preferences = tools.get_vibes();
  const published = recipes.find((recipe) => recipe.name === "vibes");
  expect(published).toBeDefined();
  expect(preferences.content[0]!.text).toBe(published!.text);
  const matches = JSON.parse(tools.search("EMAIL VOICE").content[0]!.text);
  expect(matches[0].name).toBe("email-voice");
  expect(matches[0].snippets.length).toBeGreaterThan(0);
  expect(matches[0].snippets.length).toBeLessThanOrEqual(3);
  expect(matches[0].snippets[0].toLowerCase()).toContain("email voice");
  expect(tools.search("[literal.no.match]").content[0]!.text).toBe("[]");
  expect(tools.search(" ").isError).toBe(true);
});
