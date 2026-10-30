import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  date,
  primaryKey,
  unique,
  foreignKey,
  index,
  check,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const limits = {
  recipes: 100,
  body_bytes: 32768,
  name_bytes: 64,
  description_bytes: 500,
  reason_bytes: 500,
  history_bytes: 67108864,
  daily_calls: 1000,
  daily_writes: 200,
  request_bytes: 65536,
  page_size: 50,
};
export const storeConfig = pgTable(
  "store_config",
  {
    singleton: integer("singleton").primaryKey(),
    signupMode: text("signup_mode").notNull().default("closed"),
    allowedIdentities: jsonb("allowed_identities_json").notNull().default([]),
    limits: jsonb("limits_json").notNull().default(limits),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("config_singleton", sql`${t.singleton} = 1`),
    check(
      "config_signup_mode",
      sql`${t.signupMode} IN ('closed','allowlist','open')`,
    ),
    check(
      "config_allowlist_array",
      sql`jsonb_typeof(${t.allowedIdentities}) = 'array'`,
    ),
    check("config_limits_object", sql`jsonb_typeof(${t.limits}) = 'object'`),
  ],
);
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("active"),
    templatesRevision: integer("templates_revision").notNull().default(0),
    profile: jsonb("profile_json").notNull().default({}),
    retainedBytes: bigint("retained_bytes", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check("users_status", sql`${t.status} IN ('active','deleting')`),
    check("users_revision", sql`${t.templatesRevision} >= 0`),
    check("users_profile_object", sql`jsonb_typeof(${t.profile}) = 'object'`),
    check("users_bytes", sql`${t.retainedBytes} >= 0`),
    check(
      "users_id_format",
      sql`${t.id} <> '' AND position(':' in ${t.id}) = 0`,
    ),
  ],
);
export const identities = pgTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    profile: jsonb("profile_json").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("identities_by_user").on(t.userId),
    check("identities_subject", sql`${t.subject} <> ''`),
    check(
      "identities_profile_object",
      sql`jsonb_typeof(${t.profile}) = 'object'`,
    ),
  ],
);
export const recipes = pgTable(
  "recipes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id")
      .notNull()
      .default(sql`gen_random_uuid()::text`),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    unique("recipes_user_name").on(t.userId, t.name),
    check(
      "recipes_slug",
      sql`${t.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${t.name} !~ '[^a-z0-9-]'`,
    ),
  ],
);
export const recipeVersions = pgTable(
  "recipe_versions",
  {
    userId: text("user_id").notNull(),
    recipeId: text("recipe_id").notNull(),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    archived: boolean("archived").notNull().default(false),
    reason: text("reason").notNull(),
    actorJson: text("actor_json").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    payloadBytes: bigint("payload_bytes", { mode: "number" })
      .notNull()
      .generatedAlwaysAs(
        sql`octet_length(description)::bigint + octet_length(body) + octet_length(reason) + octet_length(actor_json) + octet_length(details_json)`,
      ),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.recipeId, t.version] }),
    foreignKey({
      name: "versions_recipe",
      columns: [t.userId, t.recipeId],
      foreignColumns: [recipes.userId, recipes.id],
    }).onDelete("cascade"),
    check("versions_positive", sql`${t.version} >= 1`),
    check(
      "versions_description",
      sql`${t.description} <> '' AND position(chr(10) in ${t.description}) = 0 AND position(chr(13) in ${t.description}) = 0`,
    ),
    check(
      "versions_actor_object",
      sql`jsonb_typeof(${t.actorJson}::jsonb) = 'object'`,
    ),
    check(
      "versions_details_object",
      sql`jsonb_typeof(${t.detailsJson}::jsonb) = 'object'`,
    ),
  ],
);
export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dayUtc: date("day_utc").notNull(),
    toolCalls: integer("tool_calls").notNull().default(0),
    writes: integer("writes").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.dayUtc] }),
    check("usage_nonnegative", sql`${t.toolCalls} >= 0 AND ${t.writes} >= 0`),
  ],
);
