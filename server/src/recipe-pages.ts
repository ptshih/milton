import { escapeHtml as e, page } from "./pages";
import {
  StoreError,
  type PersonStore,
  type RecipeSnapshot,
  type VersionMetadata,
} from "./store";
import { parseVersionTag } from "./store/versions";
import { downloadResponse } from "./download";

export const isRecipeRoute = (path: string) =>
  path === "/" ||
  path === "/new-recipe" ||
  path === "/recipes" ||
  path.startsWith("/recipes/") ||
  path === "/download";
type Fields = Record<string, string>;
type Names = (
  actors: Record<string, unknown>[],
) => Promise<Map<string, string>>;
const pathFor = (name: string) => `/recipes/${encodeURIComponent(name)}`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${e(value)}">`;
const numberOf = (recipe: Pick<RecipeSnapshot, "version">) =>
  parseVersionTag(recipe.version)!.number;
const fence = (recipe: RecipeSnapshot) =>
  hidden("expected_version", recipe.version) +
  hidden("recipe_id", parseVersionTag(recipe.version)!.id);
const resultMessages: Record<string, string> = {
  saved: "Chef's kiss. Your recipe is saved.",
  archived: "Chef's kiss. Your recipe is archived.",
  restored: "Chef's kiss. Your recipe is restored.",
  reverted: "Chef's kiss. Your recipe is reverted.",
  deleted: "Chef's kiss. Your recipe is deleted.",
};
const status = (url: URL) =>
  Object.hasOwn(resultMessages, url.searchParams.get("result") ?? "")
    ? resultMessages[url.searchParams.get("result")!]!
    : "";
const nav =
  '<nav aria-label="Recipes"><a href="/">Your recipes</a><a href="/new-recipe">New recipe</a><a href="/?archived=1">Archived</a><a href="/download">Download all</a></nav>';

function editForm(
  csrf: () => string,
  recipe?: RecipeSnapshot,
  submitted?: Fields,
) {
  const fields =
    submitted ??
    (recipe
      ? { description: recipe.description, text: recipe.text, reason: "" }
      : {});
  return `<form method="post" enctype="multipart/form-data" action="${recipe ? pathFor(recipe.name) + "/save" : "/recipes"}">${csrf()}${recipe ? fence(recipe) : '<label>Name<input name="name" required maxlength="64" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="' + e(fields.name ?? "") + '"></label>'}<label>Description<input name="description" required value="${e(fields.description ?? "")}"></label><label>Recipe<textarea name="text" rows="16">${e(fields.text ?? "")}</textarea></label>${recipe ? `<label>Reason<input name="reason" value="${e(fields.reason ?? "")}"></label>` : ""}<button>${recipe ? "Save recipe" : "Create recipe"}</button></form>`;
}

function editor(
  csrf: () => string,
  recipe: RecipeSnapshot,
  message = "",
  submitted?: Fields,
  code = 200,
) {
  const action = (verb: string, label: string, fields = "") =>
    `<form method="post" enctype="multipart/form-data" action="${pathFor(recipe.name)}/${verb}">${csrf()}${fence(recipe)}${fields}<button class="secondary">${label}</button></form>`;
  const controls =
    recipe.name === "vibes"
      ? ""
      : `${recipe.archived ? action("restore", "Restore recipe") : action("archive", "Archive recipe", '<label>Reason<input name="reason" value="Archived recipe"></label>')}<details><summary>Delete recipe</summary><p>Deletes this recipe and every version. Type <strong>${e(recipe.name)}</strong> to confirm.</p>${action("delete", "Delete recipe and history", '<label>Recipe name<input name="confirmation" required autocomplete="off"></label>')}</details>`;
  return page(
    recipe.name === "vibes" ? "Your vibes" : recipe.name,
    `${nav}${message ? `<p role="status">${e(message)}</p>` : ""}<p>Version ${numberOf(recipe)} · ${recipe.archived ? "Archived" : "Active"} · <a href="${pathFor(recipe.name)}/history">Version history</a></p>${submitted ? `<section><h2>Current saved version</h2><p>${e(recipe.description)}</p><pre>${e(recipe.text)}</pre><h2>Your unsaved edit</h2></section>` : ""}${editForm(csrf, recipe, submitted)}${controls}`,
    code,
  );
}

function author(version: VersionMetadata, names: Map<string, string>) {
  const actor = version.actor;
  if (actor.kind === "person") return "You";
  if (actor.kind === "assistant" && typeof actor.client_id === "string")
    return (
      names.get(String(actor.issuer) + "\0" + actor.client_id) ??
      actor.client_id
    );
  if (actor.kind === "system" && actor.id === "template-seed")
    return "Initial template";
  if (
    actor.kind === "import" ||
    actor.kind === "person-import" ||
    actor.id === "recipe-import"
  )
    return "Recipe import";
  return "System / imported version";
}

function plainDiff(previous: RecipeSnapshot | null, selected: RecipeSnapshot) {
  const lines = (recipe: RecipeSnapshot | null) =>
    recipe
      ? [
          `Description: ${recipe.description}`,
          `Archived: ${recipe.archived}`,
          ...recipe.text.split("\n"),
        ]
      : [];
  const before = lines(previous),
    after = lines(selected);
  let start = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (
    start < endBefore &&
    start < endAfter &&
    before[start] === after[start]
  )
    start++;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  return (
    [
      ...before.slice(start, endBefore).map((line) => `− ${line}`),
      ...after.slice(start, endAfter).map((line) => `+ ${line}`),
    ].join("\n") || "No text or archive changes."
  );
}

export async function recipePages(
  request: Request,
  store: PersonStore,
  csrf: () => string,
  names: Names,
  form?: Fields,
): Promise<Response> {
  const url = new URL(request.url);
  const match =
    /^\/recipes\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(history|save|archive|restore|revert|delete)(?:\/([1-9][0-9]{0,9}))?)?$/.exec(
      url.pathname,
    );
  if (request.method === "POST") {
    if (!(
      url.pathname === "/recipes" ||
      (match &&
        ["save", "archive", "restore", "revert", "delete"].includes(
          match[2] ?? "",
        ) &&
        !match[3])
    ))
      return page("Not found", nav, 404);
    const submitted = form!;
    let current: RecipeSnapshot | null = null;
    try {
      const action = match?.[2] ?? "create";
      const allowed = [
        "csrf",
        ...(action === "create"
          ? ["name", "description", "text"]
          : [
              "recipe_id",
              "expected_version",
              ...(action === "save"
                ? ["description", "text", "reason"]
                : action === "archive"
                  ? ["reason"]
                  : action === "revert"
                    ? ["source_version"]
                    : action === "delete"
                      ? ["confirmation"]
                      : []),
            ]),
      ];
      if (Object.keys(submitted).some((key) => !allowed.includes(key)))
        throw new StoreError(
          "invalid_input",
          "Check the recipe fields and try again.",
          400,
        );
      if (!match) {
        const made = await store.createRecipe({
          name: submitted.name!,
          description: submitted.description!,
          text: submitted.text!,
        });
        return new Response(null, {
          status: 303,
          headers: { Location: pathFor(made.name) + "?result=saved" },
        });
      }
      const name = match[1]!;
      current =
        name === "vibes" ? await store.getVibes() : await store.getRecipe(name);
      if (!current)
        throw new StoreError("not_found", "This recipe does not exist.", 404);
      const tag = parseVersionTag(submitted.expected_version ?? "");
      if (!tag || submitted.recipe_id !== tag.id)
        throw new StoreError(
          "recipe_version_conflict",
          "Read the current recipe before trying another write.",
          409,
        );
      const input = { name, expected_version: submitted.expected_version! };
      if (action === "save")
        await store.updateRecipe({
          ...input,
          description: submitted.description!,
          text: submitted.text!,
          reason: submitted.reason!,
        });
      else if (action === "archive")
        await store.archiveRecipe({ ...input, reason: submitted.reason! });
      else if (action === "restore") await store.restoreRecipe(input);
      else if (action === "revert") {
        if (!/^[1-9][0-9]{0,9}$/.test(submitted.source_version ?? ""))
          throw new StoreError(
            "invalid_input",
            "Choose a stored version to revert to.",
            400,
          );
        await store.revertRecipe({
          ...input,
          source_version: Number(submitted.source_version),
        });
      } else
        await store.deleteRecipe({
          ...input,
          confirmation: submitted.confirmation!,
        });
      const result = {
        save: "saved",
        archive: "archived",
        restore: "restored",
        revert: "reverted",
        delete: "deleted",
      }[action];
      return new Response(null, {
        status: 303,
        headers: {
          Location:
            (action === "delete" ? "/" : pathFor(name)) + "?result=" + result,
        },
      });
    } catch (error) {
      const failure =
        error instanceof StoreError
          ? error
          : new StoreError(
              "store_unavailable",
              "The write outcome is unavailable. Read the current recipe before retrying.",
            );
      let deleted = failure.code === "not_found";
      if (match && current) {
        // Re-read after a conflict; never replace submitted text with the saved head.
        const latest = await store.getRecipe(match[1]!).catch(() => current);
        if (latest)
          return editor(
            csrf,
            latest,
            failure.message,
            match[2] === "save" ? submitted : undefined,
            failure.status,
          );
        deleted = true;
      }
      if (match?.[2] === "save")
        return page(
          "Unsaved recipe",
          `${nav}<p>${e(deleted ? "This recipe was deleted. Save it as a new recipe?" : failure.message)}</p>${editForm(csrf, undefined, { ...submitted, name: match[1]! })}`,
          failure.status,
        );
      return page(
        "We're cooked.",
        `${nav}<p>${e(failure.message)}</p>${!match ? editForm(csrf, undefined, submitted) : ""}`,
        failure.status,
      );
    }
  }
  if (request.method !== "GET") return page("Method not allowed", nav, 405);
  if (url.pathname === "/download") {
    await store.getVibes();
    return downloadResponse(await store.downloadRecipes());
  }
  if (url.pathname === "/new-recipe")
    return page("New recipe", nav + editForm(csrf));
  if (url.pathname === "/") {
    const archived = url.searchParams.get("archived") === "1";
    const vibes = await store.getVibes();
    const [recipes, usage] = await Promise.all([
      store.listRecipes(
        url.searchParams.get("cursor") ?? undefined,
        archived,
        true,
      ),
      store.usage(),
    ]);
    return page(
      "Your vibes",
      `${nav}${status(url) ? `<p role="status">${e(status(url))}</p>` : ""}<ul class="recipe-list"><li><a href="/recipes/vibes">Edit your vibes</a><span>Version ${numberOf(vibes)}</span><p>${e(vibes.description)}</p></li></ul><section><h2>${archived ? "Archived recipes" : "Your recipes"}</h2>${recipes.items.length ? `<ul class="recipe-list">${recipes.items.map((recipe) => `<li><a href="${pathFor(recipe.name)}">${e(recipe.name)}</a><span>Version ${numberOf(recipe)}</span><p>${e(recipe.description)}</p></li>`).join("")}</ul>` : "<p>No recipes here yet.</p>"}${recipes.next_cursor ? `<a href="/?${archived ? "archived=1&amp;" : ""}cursor=${encodeURIComponent(recipes.next_cursor)}">Older recipes</a>` : ""}</section><section><h2>Usage</h2><p>${usage.recipes} / ${usage.limits.recipes} recipes · ${usage.writes} / ${usage.limits.daily_writes} writes today · ${usage.tool_calls} / ${usage.limits.daily_calls} assistant calls today.</p><p>${usage.retained_bytes} / ${usage.limits.history_bytes} bytes of retained history. Daily caps reset at midnight UTC.</p></section><form method="post" action="/logout">${csrf()}<button class="secondary">Sign out</button></form><p>Signing out of this browser does not disconnect your assistants.</p>`,
    );
  }
  if (
    !match ||
    (match[3] && match[2] !== "history") ||
    (match[2] && match[2] !== "history")
  )
    return page("Not found", nav, 404);
  const recipe =
    match[1] === "vibes"
      ? await store.getVibes()
      : await store.getRecipe(match[1]!);
  if (!recipe)
    return page("Not found", `${nav}<p>This recipe does not exist.</p>`, 404);
  if (!match[2]) return editor(csrf, recipe, status(url));
  if (!match[3]) {
    const versions = await store.history(
      recipe.name,
      url.searchParams.get("cursor") ?? undefined,
    );
    const labels = await names(versions.items.map((version) => version.actor));
    return page(
      `${recipe.name}: version history`,
      `${nav}<p><a href="${pathFor(recipe.name)}">Back to recipe</a></p><ol class="history">${versions.items.map((version) => `<li><a href="${pathFor(recipe.name)}/history/${version.version}">Version ${version.version}</a><p>${e(author(version, labels))} · <time>${e(version.created_at)}</time></p><p>${e(version.reason)}</p></li>`).join("")}</ol>${versions.next_cursor ? `<a href="${pathFor(recipe.name)}/history?cursor=${versions.next_cursor}">Older versions</a>` : ""}`,
    );
  }
  const number = Number(match[3]);
  if (number > 2147483647) return page("Not found", nav, 404);
  const [selected, previous] = await Promise.all([
    store.getVersion(recipe.name, number),
    number > 1 ? store.getVersion(recipe.name, number - 1) : null,
  ]);
  if (!selected) return page("Not found", nav, 404);
  const labels = await names([selected.metadata.actor]);
  return page(
    `${recipe.name}: version ${number}`,
    `${nav}<p><a href="${pathFor(recipe.name)}/history">Version history</a></p><p>${e(author(selected.metadata, labels))} · ${e(selected.metadata.created_at)}</p><p>${e(selected.metadata.reason)}</p><h2>Stored recipe</h2><p>${e(selected.description)} · ${selected.archived ? "Archived" : "Active"}</p><pre>${e(selected.text)}</pre><h2>Changes from version ${number - 1}</h2><pre>${e(plainDiff(previous, selected))}</pre><form method="post" enctype="multipart/form-data" action="${pathFor(recipe.name)}/revert">${csrf()}${fence(recipe)}${hidden("source_version", String(number))}<button>Revert to this version</button></form>`,
  );
}
