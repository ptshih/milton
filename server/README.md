# Self-hosting Milton

Milton maintains internal memos containing working instructions. Connected assistants
submit changes through `save_memo` and read the compiled TPS Report through
`get_tps_report`. This directory contains the MCP server and current-report web app,
served by one Vercel Function on Node 24. Neon Postgres stores memos, internal memo
history, current TPS and request receipts; Neon Auth handles sign-in and authorization.

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

Saving also needs all four compiler settings. With none set, TPS reads work and
saves return `compiler_unavailable`; there is no model fallback.

| Name                              | Meaning                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `MILTON_GEMINI_API_KEY`           | Server-only Google Cloud API key for the selected project.                    |
| `MILTON_GEMINI_PROJECT_ID`        | Project authorized to use Gemini 3.8 Flash on the US endpoint.                |
| `MILTON_MODEL_ACCOUNT_BUDGET_USD` | Positive per-account daily model budget in dollars, up to six decimal places. |
| `MILTON_MODEL_GLOBAL_BUDGET_USD`  | Positive whole-installation daily model budget in dollars.                    |

The compiler reserves $0.0297 per claimed request against both budgets using
conservative pre-credit token prices. Reservations remain consumed for the UTC day
on failures or unknown usage; they are not an invoice. Choose budgets deliberately.
Keys and raw model responses are never logged. Current limits are 8,000 input-token
allowance (enforced conservatively by request bytes plus framing), 2,000 output
and thinking tokens, and one call with no automatic retry. Oversized complete
inputs or incomplete output are refused without truncation. Recheck provider
pricing before changing the model or limits.

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

The migrations create eight application tables: `store_config`, `users`,
`identities`, `memos`, `memo_versions`, `usage_daily`, `tps_reports`, and
`save_requests`. Fresh installations start with sign-ups closed.

Migration `0006_compiled_memos.sql` adds current TPS and durable save receipts.
It preserves existing memos and their version history, including content formerly
stored under the legacy `vibes` name. That content participates as an internal
memo when a new save compiles the account. Nonempty accounts with no valid compiled
TPS return `tps_report_unavailable` and the current fencing version; reads do not
invent an empty report or invoke a model. Submit a user-directed save to compile
existing sources together. Empty accounts read an empty initial report.

There are no old tool aliases, compatibility mode or rollout flags. Apply the
migration before running this server, and refresh client tool discovery. The
migration runner and the disposable rehearsal test verify atomic DDL. For an
uncertain command outcome, inspect the actual schema and migration journal before
retrying; an interrupted connection does not prove rollback.

The offline rollback script `drizzle/rollback/0006_compiled_memos.sql` parks the two
new tables and receipt guard in `milton_rollback`, retaining their rows and all memo
history. The journal is retained. Re-forward with
`drizzle/rollback/0006_compiled_memos_reforward.sql`, not by deleting the journal
entry or rerunning the forward CREATE statements. Stop the application while
using these scripts. Historical migrations 0000–0005 and their inverses remain
unchanged; their legacy naming and recovery rules are not the current public API.

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

The first admitted sign-in starts with empty TPS and no active instructions. Existing memo bodies and history are preserved. The browser views the current report; connected assistants submit user-directed changes.

## Connect an assistant

Add your configured `MCP_RESOURCE` URL as a remote HTTP MCP server. Complete
browser sign-in and consent, then call `get_tps_report`.

Exactly two tools are exposed:

| Tool                                              | Contract                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `get_tps_report()`                                | Returns `{text, version, is_empty}`. No model call or content write.                                            |
| `save_memo({text, request_id, expected_version})` | Natural-language instructions, correction or removal; UUID for the logical request and version from the report. |

`save_memo` returns `saved`, `unchanged`, `needs_clarification`, `conflict`,
`in_progress`, or `failed`, with the request ID and relevant version/question/error.
Only `saved` or `unchanged` confirms the requested outcome. Reuse the exact same
arguments to recover an uncertain request; a completed receipt returns its original
outcome without another model call or write charge. That receipt's version may be
older than the current report. Reusing an ID with different arguments is rejected.
For a conflict, read current TPS and reconsider a new request. No blind retry.

The assistant offers first setup once when empty, uses available explicit
instructions or asks questions, and shows the full draft for approval before
saving. Milton cannot inspect other assistants' memories. It stores instructions,
not factual/project memory. The assistant applies TPS to its drafts itself.

Access tokens require a valid signature, exact issuer/resource audience and expiry.
Only the verified account supplies tenant identity. MCP calls do not admit users.
Browser viewing requires a live session; sign-in/consent/logout retain their CSRF
protections. Signing out of the browser does not disconnect assistants, and an
already-issued access token can remain valid until expiry.

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

The check uses the default local origin. If you changed the port or origin, supply `--origin` with the origin hosting `/mcp`, without the `/mcp` path. Open the loopback page address it prints and complete sign-in manually. It checks OAuth discovery, DCR, PKCE, callback state, ten-tool discovery, and five read calls, including a draft check and a missing-memo refusal when the ordinary list is empty. It does not open a browser automatically or print tokens.

Run automated checks from the repository root:

```sh
bun run check-types
bun test
bun run --cwd server test:client
```

The tests use fresh PGlite databases and stubbed Auth responses. `test:client` uses an in-memory SDK connection and the empty TPS template. These checks need no live Neon credentials. The interactive `test:local` check does contact your configured Neon Auth service. Embedded tests do not prove contention between independent Neon connections.

## Store, history, and limits

`src/store/compiled.ts` snapshots all memo heads under the account lock, claims a
request and reserves its model budget in a short transaction, then releases the
locks for generation. One model proposal supplies the complete active memo set and
TPS. Publication rechecks the account, request deadline, source fingerprint and
report version; memo versions, current TPS, receipt and single write charge commit
together. Stale or invalid proposals cannot partially publish.

Internal `memo_versions` are append-only. `tps_reports` holds one replaceable
snapshot per account, with a monotonic revision and source fingerprint. There is
no TPS content history. Receipts keep input hashes and bounded outcomes, not raw
submitted text or copies of TPS. Their maximum 2-KiB result space plus metadata is
reserved against retained-history capacity when claimed, so terminal failures fit.
Completed receipts are immutable. A crashed request can expire; the same ID never
runs the model again. Daily model budgets serialize their short reservation step
using the existing config row, not a separate queue or service.

The model receives current active memos, never archived versions or a prior TPS.
Existing content under the former `vibes` core key is ordinary source for compilation.
The compiler chooses memo grouping; the database validates identity, complete
publication and size limits. These structural checks do not prove semantic fidelity.

| Limit                                       | Default                                                           |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Internal memos, including archived          | 100 (historical `vibes` row retains its existing guard exemption) |
| Memo/TPS body                               | 32 KiB UTF-8                                                      |
| Description/reason                          | 500 UTF-8 bytes each                                              |
| Retained memo versions and bounded receipts | 64 MiB per account                                                |
| Attempted MCP calls                         | 1,000 per account per UTC day                                     |
| Successful logical saves                    | 200 per account per UTC day                                       |
| Request body                                | 64 KiB before parsing                                             |

Each successful `save_memo` counts **once**, regardless of internal memo changes.
No-op, clarification, conflict, failed saves and receipt replays consume no extra
write allowance. Every attempted MCP call still counts, including retries. Model
spending is separately bounded, even when a call produces no change. There are no
public archive/restore exemptions or history controls.

The website shows current TPS only, escapes its text and serves no browser
JavaScript. `/download` returns its exact text as `TPS.md`. Old memo, history and
mutation routes return 404. Model failure keeps the last coherent report readable.

## Import existing memos

This administrative importer is for offline data work, not the agent interface. It changes canonical sources without compilation; TPS reads then refuse the stale snapshot until a user-directed `save_memo` compiles the new sources. The importer requires an explicit `--source-dir`. The repository contains the empty TPS `templates/`, not your personal memos. The administrative importer still addresses TPS with the internal `vibes` folder/key; this is a maintenance exception, not an MCP alias. Prepare a directory of `<name>/SKILL.md` folders with valid name and description frontmatter.

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
