import { sql } from "drizzle-orm";
import { z } from "zod";
import { databaseFailure, type StoreDatabase } from "./database";
import { StoreError } from "./errors";
import { readLimits, utf8Bytes, type RecipeSnapshot } from "./index";
import { parseVersionTag, versionTag } from "./versions";

const text = z
  .string()
  .refine((value) => !value.includes("\0"), "NUL is not allowed.");
const name = text
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const description = text.min(1).refine((value) => !/[\r\n]/.test(value));
const expected_version = z.string();
export const createInput = z.strictObject({ name, description, text });
export const updateInput = z.strictObject({
  name,
  text,
  reason: text,
  expected_version,
  description: description.optional(),
});
export const archiveInput = z.strictObject({
  name,
  reason: text,
  expected_version,
});
const recoveryInput = z.strictObject({
  name,
  expected_version,
  source_version: z.number().int().positive().max(2147483647),
});
const restoreInput = z.strictObject({ name, expected_version });
const deleteInput = z.strictObject({
  name,
  expected_version,
  confirmation: text,
});

export type CreateInput = z.infer<typeof createInput>;
export type UpdateInput = z.infer<typeof updateInput>;
export type ArchiveInput = z.infer<typeof archiveInput>;
type Actor =
  { kind: "person" } | { kind: "assistant"; issuer: string; client_id: string };
type Head = {
  id: string;
  name: string;
  description: string;
  body: string;
  version: number;
  archived: boolean;
};
const headSnapshot = (row: Head): RecipeSnapshot => ({
  name: row.name,
  description: row.description,
  text: row.body,
  version: versionTag(row.name, row.version, row.id),
  archived: row.archived,
});

export function recipeWrites(db: StoreDatabase, userId: string, actor?: Actor) {
  type Operation =
    "create" | "update" | "archive" | "restore" | "revert" | "delete";
  async function write(kind: Operation, raw: unknown): Promise<RecipeSnapshot> {
    const schema =
      kind === "create"
        ? createInput
        : kind === "update"
          ? updateInput
          : kind === "archive"
            ? archiveInput
            : kind === "revert"
              ? recoveryInput
              : kind === "delete"
                ? deleteInput
                : restoreInput;
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new StoreError(
        "invalid_input",
        "Check the recipe fields and try again.",
        400,
      );
    const input = parsed.data;
    if (
      !actor ||
      (["revert", "restore", "delete"].includes(kind) &&
        actor.kind !== "person")
    )
      throw new StoreError(
        "person_required",
        "This action requires your signed-in browser session.",
        403,
      );
    try {
      return await db.transaction(async (tx) => {
        if (
          !(
            await tx.query(
              sql`SELECT id FROM users WHERE id=${userId} AND status='active' FOR UPDATE`,
            )
          ).length
        )
          throw new StoreError(
            "account_unavailable",
            "This Milton account is unavailable.",
            403,
          );
        const limits = await readLimits(tx);
        if (input.name === "vibes" && (kind === "archive" || kind === "delete"))
          throw new StoreError(
            "vibes_required",
            "Your vibes can be edited and reverted, not archived or deleted.",
            422,
          );
        const fields: [string, number, string][] = [
          [input.name, Math.min(64, limits.name_bytes), "name"],
        ];
        if ("text" in input)
          fields.push([input.text, Math.min(32768, limits.body_bytes), "body"]);
        if ("description" in input && input.description !== undefined)
          fields.push([
            input.description,
            Math.min(500, limits.description_bytes),
            "description",
          ]);
        if ("reason" in input && typeof input.reason === "string")
          fields.push([
            input.reason,
            Math.min(500, limits.reason_bytes),
            "reason",
          ]);
        for (const [value, limit, field] of fields)
          if (utf8Bytes(value) > limit)
            throw new StoreError(
              `recipe_${field}_limit`,
              `The recipe ${field} exceeds its size limit.`,
              422,
            );
        const row = (
          await tx.query<Head>(sql`SELECT r.id,r.name,v.description,v.body,v.version,v.archived
          FROM recipes r JOIN recipe_versions v ON v.user_id=r.user_id AND v.recipe_id=r.id
          WHERE r.user_id=${userId} AND r.name=${input.name}
          ORDER BY v.version DESC LIMIT 1 FOR UPDATE OF r`)
        )[0];
        const conflict = () =>
          new StoreError(
            "recipe_version_conflict",
            "Read the current recipe before trying another write.",
            409,
            { current: row ? headSnapshot(row) : null },
          );
        if (kind === "create") {
          if (row || input.name === "vibes") throw conflict();
        } else {
          if (!row)
            throw new StoreError(
              "not_found",
              "This recipe does not exist.",
              404,
            );
          const tag =
            "expected_version" in input
              ? parseVersionTag(input.expected_version)
              : null;
          if (
            !tag ||
            tag.name !== row.name ||
            tag.id !== row.id ||
            tag.number !== row.version
          )
            throw conflict();
        }
        if (kind === "delete") {
          if (!("confirmation" in input) || input.confirmation !== input.name)
            throw new StoreError(
              "confirmation_required",
              "Type the recipe name exactly to delete it.",
              400,
            );
          await tx.query(
            sql`DELETE FROM recipes WHERE user_id=${userId} AND id=${row!.id}`,
          );
          return headSnapshot(row!);
        }
        if (
          (kind === "archive" && row!.archived) ||
          (kind === "restore" && !row!.archived)
        )
          throw new StoreError(
            "recipe_state_conflict",
            "The recipe is already in that state. Read it again.",
            409,
          );
        let source = row;
        if (kind === "revert" && "source_version" in input) {
          const chosen = (
            await tx.query<Head>(sql`SELECT ${row!.id} AS id,${row!.name} AS name,description,body,version,archived
            FROM recipe_versions WHERE user_id=${userId} AND recipe_id=${row!.id} AND version=${input.source_version}`)
          )[0];
          if (!chosen)
            throw new StoreError(
              "recipe_recovery_invalid",
              "That stored version is unavailable for recovery.",
              422,
            );
          source = chosen;
        }
        const recovery = kind === "revert" || kind === "restore";
        if (!recovery) {
          const { day } = (
            await tx.query<{ day: string }>(
              sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`,
            )
          )[0]!;
          const charged =
            await tx.query(sql`INSERT INTO usage_daily (user_id,day_utc,writes) VALUES (${userId},${day}::date,1)
            ON CONFLICT (user_id,day_utc) DO UPDATE SET writes=usage_daily.writes+1 WHERE usage_daily.writes < ${limits.daily_writes} RETURNING writes`);
          if (!charged.length)
            throw new StoreError(
              "rate_limited",
              "The daily recipe write limit has been reached.",
              429,
              {
                limit: "writes",
                retry_at_ms: Date.parse(`${day}T00:00:00Z`) + 86400000,
              },
            );
        }
        const id =
          kind === "create"
            ? (
                await tx.query<{ id: string }>(
                  sql`INSERT INTO recipes (user_id,name) VALUES (${userId},${input.name}) RETURNING id`,
                )
              )[0]!.id
            : row!.id;
        const number = (row?.version ?? 0) + 1;
        const body = "text" in input ? input.text : source!.body;
        const desc =
          "description" in input && input.description !== undefined
            ? input.description
            : source!.description;
        const archived =
          input.name === "vibes"
            ? false
            : kind === "archive"
              ? true
              : kind === "restore" || kind === "create"
                ? false
                : source!.archived;
        const reason =
          kind === "create"
            ? "Created recipe"
            : kind === "restore"
              ? "Restored recipe"
              : kind === "revert"
                ? `Reverted to version ${source!.version}`
                : "reason" in input && typeof input.reason === "string"
                  ? input.reason
                  : "";
        const details = {
          kind,
          ...(recovery ? { source_version: source!.version } : {}),
        };
        await tx.query(sql`INSERT INTO recipe_versions (user_id,recipe_id,version,description,body,archived,reason,actor_json,details_json)
          VALUES (${userId},${id},${number},${desc},${body},${archived},${reason},${JSON.stringify(actor)},${JSON.stringify(details)})`);
        return headSnapshot({
          id,
          name: input.name,
          version: number,
          description: desc,
          body,
          archived,
        });
      });
    } catch (error) {
      const failure = databaseFailure(error);
      if (failure.code === "store_unavailable")
        throw new StoreError(
          "store_unavailable",
          "The write outcome is unavailable. Read the current recipe before retrying.",
        );
      throw failure;
    }
  }
  return {
    createRecipe: (input: CreateInput) => write("create", input),
    updateRecipe: (input: UpdateInput) => write("update", input),
    archiveRecipe: (input: ArchiveInput) => write("archive", input),
    restoreRecipe: (input: z.infer<typeof restoreInput>) =>
      write("restore", input),
    revertRecipe: (input: z.infer<typeof recoveryInput>) =>
      write("revert", input),
    deleteRecipe: (input: z.infer<typeof deleteInput>) =>
      write("delete", input),
  };
}
