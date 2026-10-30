# Self-hosting Milton

Milton keeps your instructions as recipes that connected AI assistants can read and update. This directory contains the MCP server and the browser app, served by one Vercel Function on Node 24. Neon Postgres stores recipes and their version history, and Neon Auth handles sign-in and assistant authorization. The browser app lets you edit, archive, restore, revert, delete, and download recipes.

## Prerequisites

- Bun, using the version pinned in the repository's root `package.json`, and Node 24.
- A Neon project with Auth and its OAuth provider plugin enabled. Create a Postgres database named `milton`. The migration and import commands require the `neondb_owner` role, and database connections require TLS.
- A Google OAuth app, a GitHub OAuth app, or both. Configure their credentials in Neon Auth for your branch.
- A Vercel project connected to your copy of this repository, with Root Directory set to `server` and Node.js Version set to 24. Enable access to source files outside the Root Directory so the build can read workspace packages and `templates/`.
- An HTTPS origin for the browser app and an HTTPS URL ending in `/mcp` for assistants. They can share one hostname. The public service uses `app.meetmilton.com` and `mcp.meetmilton.com`; use your own addresses for your installation.

## Configure Neon Auth

Use the same branch's Auth settings and issuer throughout your installation.

For each social provider, copy the callback URL from its Neon Auth configuration into the Google or GitHub app. Its form is `{NEON_AUTH_BASE_URL}/callback/google` or `{NEON_AUTH_BASE_URL}/callback/github`. These callbacks belong to Neon, not to Milton's browser app. Save the provider's client ID and secret in Neon Auth.

Configure the OAuth provider plugin:

| Setting                             | Configuration                                                 |
| ----------------------------------- | ------------------------------------------------------------- |
| Login page URL                      | The browser app origin followed by `/login`                   |
| Consent page URL                    | The browser app origin followed by `/consent`                 |
| MCP server URL                      | The exact URL represented by `MCP_RESOURCE`, including `/mcp` |
| Client ID Metadata Documents (CIMD) | Enabled                                                       |
| Dynamic client registration (DCR)   | Enabled                                                       |
| Trusted origin                      | The exact browser app origin represented by `APP_ORIGIN`      |

Milton supplies the login and consent pages. Neon supplies authorization, token exchange, client registration, and signing keys. There is no separate MCP plugin to enable in Neon.

## Environment variables

Set these in the Vercel project's environment settings before deploying. Keep credentials in secret storage or ignored environment files.

| Name                      | Meaning                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`              | The browser app's absolute HTTPS origin, without a path, query, or fragment.                                                                      |
| `MCP_RESOURCE`            | The exact public MCP resource URL, ending in `/mcp`. Tokens must include this resource in their audience.                                         |
| `NEON_AUTH_BASE_URL`      | The exact branch Auth URL copied from Neon, including its database and Auth path, without a trailing slash. It is also the expected token issuer. |
| `NEON_AUTH_COOKIE_SECRET` | A fresh random server-only secret of at least 32 characters for browser session cookies.                                                          |
| `DATABASE_URL`            | The TLS connection string for the `milton` database. Use the owner connection for migrations and imports.                                         |
| `RECIPES_SOURCE`          | Optional recipe-source selector. Leaving it unset uses the tenant database store; bundled recipe serving is unavailable.                          |

Use separate Neon branches and matching environment settings for development and previews. After changing Vercel environment variables, create a new deployment for them to take effect.

## Install and migrate

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd server build
```

Put the database connection string under `DATABASE_URL` in the ignored `server/.dev.vars` file. Then, from `server/`:

```sh
bun run db:migrate
```

This command explicitly reads `.dev.vars`. It does not use `.env.local` or an inherited `DATABASE_URL`. It checks the database name and owner role, then applies pending migrations and records them in the Drizzle journal. Rerunning it applies only migrations that have not completed. Run one migration process at a time.

The migrations create six application tables: `store_config`, `users`, `identities`, `recipes`, `recipe_versions`, and `usage_daily`. A fresh installation starts with sign-ups **closed**, with no account-count cap. Running migrations alone does not admit your first user.

Apply migrations before deploying code that needs them. Migration `0004_permanent_vibes.sql` exempts vibes from the recipe count and keeps legacy recovery active without changing existing rows. Apply it before this version of the server. Its guard-only rollback is `drizzle/rollback/0004_permanent_vibes.sql`; roll back the server first, then run that SQL. The migration journal is retained, so reapply the forward SQL explicitly before redeploying this version. Existing recipe snapshots and retained-byte accounting are preserved by migration 0002, which strengthens the recovery guard without adding tables or backfilling data.

Migration 0003 removes the sign-up cap column and its constraint for both hosted and self-hosted installations. It preserves the admission mode and allow-list.

## Deploy

In Vercel, select the repository, Root Directory `server`, Framework Preset Other, and Node 24. Keep the build command, output directory, Function settings, and rewrites from `server/vercel.json`. The build generates the stylesheet from `packages/theme` and bundles the Function into `dist/milton.js`.

Add your environment variables and custom domains, then deploy. If you use separate browser and MCP hostnames, attach both to this same project. The MCP hostname keeps `/mcp`, discovery metadata, and `/health`; browser page requests redirect to the configured app origin.

Check `/health` on your deployment and open `/login` on the browser app origin. Finish the admission step below before connecting an assistant. For upgrades, keep the previous Function deployment available without replacing newer recipe data or version history.

## Admit the first user

Neon sign-in and Milton admission are separate. With the default closed configuration, a successful social sign-in can create a Neon Auth user but end with “New Milton accounts are closed.” (`admission_refused`) in Milton. Existing admitted users can still sign in when new sign-ups are closed.

Choose one admission mode. Run the SQL in Neon's SQL editor against the `milton` database.

### Allow only yourself

For a private installation, use allow-list mode. After signing in once, copy your user ID from Neon Auth's Users list. It must be the Neon Auth user ID, not your email, Google or GitHub account ID, or Milton account ID. Replace `YOUR_NEON_AUTH_USER_ID` below:

```sql
UPDATE store_config
SET signup_mode = 'allowlist',
    allowed_identities_json = jsonb_build_array(
      jsonb_build_object(
        'provider', 'neon',
        'subject', 'YOUR_NEON_AUTH_USER_ID'
      )
    ),
    updated_at = now()
WHERE singleton = 1;
```

This replaces the allow-list with that one identity. To admit more people, include an object with `provider` and `subject` for each Neon Auth user. Return to `/login` after applying the update to finish admission.

### Allow new users

To accept anyone who can complete your configured social sign-in:

```sql
UPDATE store_config
SET signup_mode = 'open',
    updated_at = now()
WHERE singleton = 1;
```

You can apply this before anyone signs in. There is no account-count cap. Setting `signup_mode` back to `closed` stops new admissions without locking out existing users.

The first admitted sign-in creates a Milton user and two starter recipes, `email-voice` and `vibes`, containing headings. Edit them on the page or import your own instructions.

## Connect an assistant

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server in the assistant's settings. Complete browser sign-in and consent, then try `get_vibes` or `list_recipes`.

The server exposes eight tools: `list_recipes`, `get_recipe`, `get_vibes`, `search`, `vibe_check`, `create_recipe`, `update_recipe`, and `archive_recipe`. Every connected assistant can read, create, update, and archive ordinary recipes. Vibes is permanent: it can be edited and reverted, but never archived, deleted, or renamed. It does not count toward the recipe limit. Only you, through the signed-in browser app, can revert, restore, or delete them. No custom read/write OAuth scopes are required.

`get_vibes` returns `is_template: true` when the body is empty or still matches the starter, ignoring outer whitespace and CRLF line endings. The assistant offers a vibe check once per conversation when vibes is not set up yet. `vibe_check` returns a static interview and drafting guide; it makes no model call or recipe write. The assistant must show the draft and obtain approval before saving it. Explicitly requesting a check also works with customized vibes.

Milton verifies access-token signatures, the exact branch issuer, the resource audience, and expiry. MCP calls look up an existing active Milton account; they do not admit users. Reading vibes through `get_vibes` or the page recreates a missing recipe with an empty body at version 1, attributed to the system with reason "Created vibes". Legacy archived vibes is restored as a new system version with its content preserved. Browser actions verify a live Neon session and use CSRF protection. Signing out of the browser does not disconnect assistants. Revoking a grant in Neon does not immediately invalidate an already issued JWT, which can remain valid for up to its one-hour lifetime.

## Local development and checks

Use a development Neon branch. Put the runtime environment variables in ignored `server/.env.local`, and configure the app and MCP URLs for your chosen loopback origin and port. Enable loopback access in that branch's Neon Auth settings and set its login, consent, and trusted-origin settings consistently. Apply migrations and configure admission for that database too.

The local server uses port 3001 unless you override it with `PORT`. Check that the port is unused before starting. From the repository root:

```sh
bun run --cwd server dev
```

In another terminal, run the interactive OAuth check:

```sh
bun run --cwd server test:local
```

The check uses the default local origin. If you changed the port or origin, supply `--origin` with the origin hosting `/mcp`, without the `/mcp` path. Open the loopback page address it prints and complete sign-in manually. It checks OAuth discovery, DCR, PKCE, callback state, eight-tool discovery, and calls to the four read tools. It does not open a browser automatically or print tokens.

Run automated checks from the repository root:

```sh
bun run check-types
bun test
bun run --cwd server test:client
```

The tests use fresh PGlite databases and stubbed Auth responses. `test:client` uses an in-memory SDK connection and starter templates. These checks need no live Neon credentials. The interactive `test:local` check does contact your configured Neon Auth service. Embedded tests do not prove contention between independent Neon connections.

## Store, history, and limits

All runtime SQL lives in `src/store/`. Each request gets an accessor bound to the verified user's account. Reads use Neon HTTP; writes use real WebSocket transactions that lock the active user first, then the recipe. There are no shared tenant caches or module-global database connections.

Each successful write appends one immutable snapshot with its author, time, and reason. Reads return a tag containing the recipe's immutable ID and integer version. Update and archive require that exact tag as `expected_version`. A stale tag, including one from a deleted and recreated ordinary recipe, returns a conflict with the current text and tag. Read the current recipe before retrying a conflict or an uncertain write outcome.

Revert appends a copy of the selected stored version, including archive state for ordinary recipes; vibes stays active. Restore copies the current archived head and changes only its archive flag. Recovery must copy an eligible stored snapshot; an arbitrary new body cannot claim the recovery exemption. Deleting a recipe removes its history and releases its retained bytes.

Default caps are configurable in `store_config.limits_json`:

| Limit                               | Default                    |
| ----------------------------------- | -------------------------- |
| Recipes, including archived recipes | 100                        |
| Body                                | 32 KiB of UTF-8 text       |
| Name                                | 64 UTF-8 bytes             |
| Description and reason              | 500 UTF-8 bytes each       |
| Retained version payloads           | 64 MiB per user            |
| MCP tool calls                      | 1,000 per user per UTC day |
| Ordinary writes                     | 200 per user per UTC day   |
| Request body                        | 64 KiB before parsing      |
| List, search, and history pages     | At most 50 items           |

Attempted MCP calls count toward the call cap, including invalid arguments and retries. Only successful ordinary writes consume the write allowance; a refusal rolls back its charge. Revert and restore bypass daily write and retained-history ceilings, while their bytes still count as retained history. Deletion remains available at full caps. Daily allowances reset at midnight UTC. The browser page has no request counter.

The page shows version history and plain-text diffs, escapes recipe text, and serves no browser JavaScript. Assistant authors are stored as issuer and exact client ID. History resolves display names from the signed-in person's grants, with bounded lookups and a client-ID fallback if metadata is unavailable.

Download all reads one consistent snapshot of current unarchived recipes and produces `<name>/SKILL.md` folders with quoted YAML name and description fields. Active `vibes` also supplies top-level `VIBES.md`; the page repairs a missing or legacy archived vibes recipe before producing the archive. Bodies retain their stored bytes. History and attribution are excluded. Downloads above 4,000,000 bytes are refused without truncation.

## Import existing recipes

The importer requires an explicit `--source-dir`. The repository contains starter `templates/`, not your personal recipes. Prepare a directory of `<name>/SKILL.md` folders with valid name and description frontmatter.

Find your Milton account ID in the `milton` database:

```sql
SELECT u.id AS milton_user_id
FROM users AS u
JOIN identities AS i ON i.user_id = u.id
WHERE i.provider = 'neon'
  AND i.subject = 'YOUR_NEON_AUTH_USER_ID';
```

Export the connection string as `DATABASE_URL` in the import process's environment. Set `RECIPE_SOURCE_DIR` to your source directory and `MILTON_USER_ID` to the account ID returned above. From `server/`, for starter recipes still at version 1:

```sh
bun --no-env-file scripts/import-recipes.ts \
  --source-dir "$RECIPE_SOURCE_DIR" \
  --user "$MILTON_USER_ID" \
  --expected-version email-voice=1 \
  --expected-version vibes=1
```

The importer reads inherited `DATABASE_URL` or an absolute URL-only file supplied through `--database-url-file`, never both. It does not read `.env.local` or `.dev.vars`. Keep connection strings out of command arguments, source, and logs.

For an existing recipe, pass its current integer version using `--expected-version name=number`. A fresh name defaults to expected version 0. These administrative flags use integers, unlike MCP's version tags.

The importer validates UTF-8, preserves source bytes, and imports every requested recipe in one transaction. A conflict rolls the whole import back. It verifies the stored snapshots after commit before reporting success. An uncertain post-commit result requires reading the committed versions before retrying. Import respects recipe, field, and history caps without consuming the daily write allowance.
