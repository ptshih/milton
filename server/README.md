# Self-hosting Milton

Milton keeps your instructions as memos that connected AI assistants can read and update. This directory contains the MCP server and the browser app, served by one Vercel Function on Node 24. Neon Postgres stores memos and their version history, and Neon Auth handles sign-in and assistant authorization. The browser app displays TPS and memos, offers ordinary Archive/Restore and stored-version recovery, and downloads current content.

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
| `MEMOS_SOURCE`            | Optional memo-source selector. Leaving it unset uses the tenant database store; bundled memo serving is unavailable.                              |

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

The migrations create six application tables: `store_config`, `users`, `identities`, `memos`, `memo_versions`, and `usage_daily`. A fresh installation starts with sign-ups **closed**, with no account-count cap. Running migrations alone does not admit your first user.

Migration `0005_memos_rename.sql` changes the physical tables to `memos` and `memo_versions`, the foreign-key column to `memo_id`, and the count-limit key to `limits_json.memos`. It also renames constraints, backing indexes, functions and triggers, and updates their bodies. PostgreSQL 18's named NOT NULL constraints are included when present. It preserves IDs, slugs, versions, timestamps, stored text and attribution, retained bytes, usage, and all cap values. Existing content and historical actor IDs are never rewritten. Historical migrations and snapshots remain unchanged.

The application keeps the historical internal core key `vibes`, including in unchanged SQL guards and opaque tags. The public name is TPS Report; no 0006 is needed.

**Upgrades require coordinated maintenance.** Old Functions cannot use the renamed schema. Follow the cutover below; do not run this migration during an ordinary rolling deployment. New installations can apply all migrations before their first deployment.

Migration `0004_permanent_vibes.sql` exempts the stable internal TPS key `vibes` from the memo count and keeps legacy recovery active. Its historical rollback only applies to a pre-0005 schema; it is not the rollback for this release. Migration 0002 strengthens recovery guards without changing stored snapshots or retained-byte accounting.

Migration 0003 removes the sign-up cap column and its constraint for both hosted and self-hosted installations. It preserves the admission mode and allow-list.

### Memo rename cutover and recovery

1. Rehearse forward, rollback, and re-forward on a disposable database. Build and verify the new server there; retain the previous server artifact for rollback. The local PGlite tests are not proof of hosted connection contention or deployment gating.
2. Block application and MCP traffic before invoking either version against a changing schema. Cover both custom domains and all old deployment URLs that could reach the database, and stop administrative imports. Drain in-flight requests and transactions. The Function's 60-second limit alone is not drain evidence. Reads such as old `get_vibes`, new `get_tps_report`, the home page, and downloads can repair stored TPS, so a write-only gate is insufficient. The deployment owner must prove this gate; the repository does not configure one.
3. Record the schema/journal state and privately compare data before and after migration. Use the intended worktree's `server/.dev.vars` with the existing migration runner; never borrow another worktree's credentials. Run one migration process. The application DDL and its journal entry commit together; lock acquisition times out after ten seconds.
4. Keep traffic blocked while applying 0005 and promoting the new server. Remove the old optional `RECIPES_SOURCE` setting and use `MEMOS_SOURCE=store` if setting it explicitly. Verify new tool discovery, TPS/memo read-only routes, agent authoring, history/recovery, and downloads with an explicit test account. `/health` does not test the schema. Publish the matching site wording, then reopen only the new server. Old deployment URLs must remain unable to reach production.
5. Refresh MCP tool discovery and browser pages. The renamed tools, list-result key `memos`, `memo_*` error codes, `/memos/...` routes, and `memo_id` form field have no old aliases. Old page URLs return 404 and stale form POSTs are rejected, never replayed. Copy unsaved old-form text before refreshing. TPS uses dedicated tools and `/tps-report`; old core paths and browser create/save/delete forms return 404 without writing. Tokens, sessions, slugs, and complete version tags remain valid.

**A failed command does not prove rollback.** A database connection can fail during cleanup after a successful commit. For any uncertain connection or command outcome, keep traffic blocked and inspect **both the physical schema and the migration journal** through a fresh connection before retrying, rolling back, or reopening traffic. Check the actual table/column names, quota keys, trigger functions, and the 0005 journal timestamp from `drizzle/meta/_journal.json`, not only a success message or process exit code. These read-only queries expose no stored memo content:

```sql
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at;
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('recipes','recipe_versions','memos','memo_versions')
ORDER BY table_name, ordinal_position;
SELECT limits_json ? 'recipes' AS old_count_key,
       limits_json ? 'memos' AS new_count_key
FROM store_config WHERE singleton=1;
SELECT proname FROM pg_proc
WHERE pronamespace='public'::regnamespace AND proname LIKE 'milton_%'
ORDER BY proname;
```

- Old schema with the journal still at 0004: a failed transaction left the old state. Verify it before retrying or reopening the old server.
- New schema with 0005 recorded: the forward transaction committed, even if the command reported failure. Continue new-server validation or perform the explicit inverse rollback under maintenance.
- Any other combination: keep traffic blocked and investigate. Old schema with 0005 recorded is only expected after a known, verified inverse rollback; never infer that an uncertain forward command performed one.

To roll back, block and drain new callers, execute `drizzle/rollback/0005_memos_rename.sql`, inspect schema and journal, then promote and verify the old server before reopening. This inverse transaction retains every committed version, including new writes made after forward. It restores the guards effective after 0004, not the older guards in the 0004 rollback. The old UI may show the generic imported/system label for a new `memo-import` actor; stored attribution is intact. Clients must refresh tool discovery again.

The inverse deliberately retains the 0005 journal row. Consequently, `db:migrate` alone cannot re-forward after rollback. Reapply the reviewed `0005_memos_rename.sql` explicitly inside one transaction under the same maintenance gate, with schema-state verification before and after, without inserting a duplicate journal row. Do not resume normal migration/deployment commands while schema and journal intentionally differ. Handle uncertain rollback or re-forward outcomes with the same fresh-connection inspection.

## Deploy

In Vercel, select the repository, Root Directory `server`, Framework Preset Other, and Node 24. Keep the build command, output directory, Function settings, and rewrites from `server/vercel.json`. The build generates the stylesheet from `packages/theme` and bundles the Function into `dist/milton.js`.

Add your environment variables and custom domains, then deploy. If you use separate browser and MCP hostnames, attach both to this same project. The MCP hostname keeps `/mcp`, discovery metadata, and `/health`; browser page requests redirect to the configured app origin.

Check `/health` on your deployment and open `/login` on the browser app origin. Finish the admission step below before connecting an assistant. For upgrades, keep the previous Function deployment available without replacing newer memo data or version history.

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

The first admitted sign-in creates a Milton user with only empty, permanent TPS Report. Unfinished revision-0 accounts initialize the missing core and complete revision 2 in one tenant-locked transaction. Existing bodies, ordinary memos, descriptions, versions and attribution are preserved; completed accounts are never reseeded. Agents author content; the browser displays it and offers stored recovery.

## Connect an assistant

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server in the assistant's settings. Complete browser sign-in and consent, then try `get_tps_report` or `list_memos`.

The server exposes nine tools: `get_tps_report`, `update_tps_report`, `tps_check`, `list_memos`, `get_memo`, `search`, `create_memo`, `update_memo`, and `archive_memo`. There are no aliases for `get_vibes`, `vibe_check`, or recipe tools. Every connected assistant can author TPS and ordinary memos; only ordinary memos can be archived. TPS does not count toward the memo limit. The signed-in browser can Archive/Restore ordinary memos and restore a stored version of either kind. It has no content editor, New memo, Clear TPS or permanent-delete control. No custom read/write OAuth scopes are required.

`get_tps_report` returns `{title:"TPS Report",description,text,version,archived:false,is_template}`. `update_tps_report` takes `{text,reason,expected_version,description?}` with no name; empty text is valid. The stable internal key remains `vibes` to preserve IDs and opaque version tags. Generic memo tools refuse that key. Ordinary `tps` and `tps-report` slugs coexist independently, including `/memos/tps-report` beside `/tps-report`.

`list_memos` lists active ordinary memos only. `search` includes active TPS with `kind:"tps_report"` and a public title, and ordinary hits with `kind:"memo"` and a name. It searches TPS's public title, description and body, never its hidden key. Archived ordinary content is excluded from all assistant reads and error responses. Direct reads return `not_found`; duplicate create, update and repeated archive return `memo_archived` with only name/version/archive metadata. Archive success returns only `{name,version,archived:true}`. The owner retains archived content/history access in the app.

`is_template` recognizes empty bodies and the exact legacy `# Working style` starter, ignoring outer whitespace and CRLF. The assistant offers TPS setup once per conversation when unset. `tps_check` returns a static drafting guide with no model call or write: use available explicit working preferences first, ask useful follow-ups, or use the questionnaire when none are available. Show the complete draft and obtain approval before `update_tps_report`. Confirm only after a successful save; preserve the draft and report failed, conflicting or uncertain outcomes without a blind retry. Milton cannot inspect another assistant's memory or import it automatically.

Milton verifies access-token signatures, the exact branch issuer, the resource audience, and expiry. MCP calls look up an existing active Milton account; they do not admit users. Reading TPS through `get_tps_report` or the page recreates a missing core with an empty body at version 1, attributed to the system with reason "Created TPS Report". Legacy archived TPS is restored as a new system version with reason "Restored TPS Report" and its content preserved. Historical stored reasons remain unchanged. Browser actions verify a live Neon session and use CSRF protection. Signing out of the browser does not disconnect assistants. Revoking a grant in Neon does not immediately invalidate an already issued JWT, which can remain valid for up to its one-hour lifetime.

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

The check uses the default local origin. If you changed the port or origin, supply `--origin` with the origin hosting `/mcp`, without the `/mcp` path. Open the loopback page address it prints and complete sign-in manually. It checks OAuth discovery, DCR, PKCE, callback state, nine-tool discovery, and four read calls, including a missing-memo refusal when the ordinary list is empty. It does not open a browser automatically or print tokens.

Run automated checks from the repository root:

```sh
bun run check-types
bun test
bun run --cwd server test:client
```

The tests use fresh PGlite databases and stubbed Auth responses. `test:client` uses an in-memory SDK connection and the empty TPS template. These checks need no live Neon credentials. The interactive `test:local` check does contact your configured Neon Auth service. Embedded tests do not prove contention between independent Neon connections.

## Store, history, and limits

All runtime SQL lives in `src/store/`. Each request gets an accessor bound to the verified user's account. Reads use Neon HTTP; writes use real WebSocket transactions that lock the active user first, then the memo. There are no shared tenant caches or module-global database connections.

Each successful write appends one immutable snapshot with its author, time, and reason. Reads return a tag containing the memo's immutable ID and integer version. Update and archive require that exact tag as `expected_version`. A stale tag, including one from a deleted and recreated ordinary memo, returns a conflict with the current active snapshot and tag. Read the current memo before retrying a conflict or an uncertain write outcome.

Revert appends a copy of the selected stored version, including archive state for ordinary memos; TPS stays active. Restore copies the current archived head and changes only its archive flag. Recovery must copy an eligible stored snapshot; an arbitrary new body cannot claim the recovery exemption. Restoration appends a new version and keeps every intervening version. Browser recovery accepts only CSRF, immutable ID, expected tag and, for earlier-version recovery, the stored source version; no authored content fields. Failed recovery shows a read-only current view after a successful reread. An unavailable reread shows no remembered content or action fences. A stale write is never retried automatically.

Default caps are configurable in `store_config.limits_json`:

| Limit                           | Default                    |
| ------------------------------- | -------------------------- |
| Memos, including archived memos | 100                        |
| Body                            | 32 KiB of UTF-8 text       |
| Name                            | 64 UTF-8 bytes             |
| Description and reason          | 500 UTF-8 bytes each       |
| Retained version payloads       | 64 MiB per user            |
| MCP tool calls                  | 1,000 per user per UTC day |
| Ordinary writes                 | 200 per user per UTC day   |
| Request body                    | 64 KiB before parsing      |
| List, search, and history pages | At most 50 items           |

Attempted MCP calls count toward the call cap, including invalid arguments and retries. Only successful ordinary writes consume the write allowance; a refusal rolls back its charge. Revert and restore bypass daily write and retained-history ceilings, while their bytes still count as retained history. Archive remains a normal write and can be refused at either cap; stored-head Restore and earlier-version recovery retain their exemptions. Daily allowances reset at midnight UTC. The browser page has no request counter.

The page shows version history and plain-text diffs, escapes memo text, and serves no browser JavaScript. Assistant authors are stored as issuer and exact client ID. History resolves display names from the signed-in person's grants, with bounded lookups and a client-ID fallback if metadata is unavailable.

Download all reads one consistent snapshot of current unarchived memos and produces one root `TPS.md` containing the exact TPS body and ordinary `<name>/SKILL.md` folders with quoted YAML name and description fields. There is no duplicate core Skill folder or `VIBES.md`. The page repairs a missing or legacy archived core before taking the single export snapshot. Bodies retain their stored bytes. History and attribution are excluded. Downloads above 4,000,000 bytes are refused without truncation.

## Import existing memos

The importer requires an explicit `--source-dir`. The repository contains the empty TPS `templates/`, not your personal memos. The administrative importer still addresses TPS with the internal `vibes` folder/key; this is a maintenance exception, not an MCP alias. Prepare a directory of `<name>/SKILL.md` folders with valid name and description frontmatter.

Find your Milton account ID in the `milton` database:

```sql
SELECT u.id AS milton_user_id
FROM users AS u
JOIN identities AS i ON i.user_id = u.id
WHERE i.provider = 'neon'
  AND i.subject = 'YOUR_NEON_AUTH_USER_ID';
```

Export the connection string as `DATABASE_URL` in the import process's environment. Set `MEMO_SOURCE_DIR` to your source directory and `MILTON_USER_ID` to the account ID returned above. From `server/`, for the empty TPS still at version 1 and a new ordinary email-voice memo:

```sh
bun --no-env-file scripts/import-memos.ts \
  --source-dir "$MEMO_SOURCE_DIR" \
  --user "$MILTON_USER_ID" \
  --expected-version email-voice=0 \
  --expected-version vibes=1
```

The importer reads inherited `DATABASE_URL` or an absolute URL-only file supplied through `--database-url-file`, never both. It does not read `.env.local` or `.dev.vars`. Keep connection strings out of command arguments, source, and logs.

For an existing memo, pass its current integer version using `--expected-version name=number`. A fresh name defaults to expected version 0. These administrative flags use integers, unlike MCP's version tags.

The importer validates UTF-8, preserves source bytes, and imports every requested memo in one transaction. A conflict rolls the whole import back. It verifies the stored snapshots after commit before reporting success. An uncertain post-commit result requires reading the committed versions before retrying. Import respects memo, field, and history caps without consuming the daily write allowance.
