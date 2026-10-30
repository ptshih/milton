# Milton: spec

_Design notes, kept in the order decisions were made. The sections up to "Version 2: Milton for anyone" describe the first, read-only plan and are history; what runs today is version 2 (README.md says what is built)._

## What it is

Milton is one private server that every AI assistant Peter uses can connect to, so they all write and work the
way he wants: his email voice, his working style and, later, other recipes. It is an MCP server (the
standard plug-in format that Claude, ChatGPT, Muse and Grok all accept as a "custom connector").
Agents can read recipes and, with permission, suggest changes or save notes.

Milton takes over the shelved Milton project: its repository `ptshih/milton`, the domain `meetmilton.com`, the Cloudflare account that holds its DNS, and the GitHub App `milton-assistant`. The recipes live in that repository and nowhere else.
That repository is the source: Peter edits it, the server serves it, and agents propose changes to
it. Nothing private ever goes in it, so nothing private can leak through the server.

## Who connects

| Client                                | How it connects                                                                                                                  | Confidence                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| claude.ai (web, Desktop chat, iPhone) | Custom connector, sign-in with OAuth; added on the web, then available on Desktop and iPhone. Pro plan or above                  | Confirmed (Anthropic support article) |
| ChatGPT                               | Developer mode → custom connector, OAuth. Which plans allow it, and whether personal plans can write, is unclear                 | Likely; test on Peter's plan          |
| Meta Muse                             | Settings → Connectors → custom connector by URL. Sources disagree on OAuth versus a key in a header, so the server supports both | Likely; test                          |
| Grok Bot                              | Settings → Plugins, remote connectors on a paid plan                                                                             | From forum posts only; test           |
| Claude Duet                           | Unknown: Peter to say what it is                                                                                                 | Open                                  |
| Claude Code, Codex, Pi                | Read the repository's clone on the Mac directly (below); can also use the server                                                 | Confirmed                             |

## What it serves (version 1)

- **email-voice**: moved from `~/.agents/skills/email-voice` into `recipes/email-voice/`.
- **working-style**: a new short recipe for working with Peter outside code (answer first, plain
  English, render options before applying, a terse word authorizes one step, "what do you think"
  asks for candor). Peter approved its text on 2026-10-29.

The repository holds only recipes meant for every assistant. Employers, investors, customers, project
rules, tools and memory stay in `~/.agents` and the project repositories, which the server never
reads.

## What agents can do

Every tool call is logged with the client's name.

| Tool                                      | What it does                                                                              | Needs |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| `list_recipes`                             | Names and one-line descriptions of every recipe                                            | read  |
| `get_recipe(name)`                         | One recipe in full                                                                         | read  |
| `get_vibes`                         | The vibes recipe                                                                     | read  |
| `search(words)`                           | Plain text search across recipes                                                           | read  |
| `remember(note, topic)`                   | Adds a note to an inbox for Peter to review, such as "Peter prefers 'Best,' to 'Thanks,'" | write |
| `propose_change(recipe, new_text, reason)` | Opens a pull request with the edited recipe; nothing changes until Peter merges it         | write |

The server also sends one standing instruction when a client connects: "Before writing anything for
or as Peter, call `get_vibes` and the recipe that fits the task." Clients that ignore it get the
same line in their own custom-instruction setting.

## How writing works

Agents never change a recipe directly. A `remember` note is committed to `inbox.md`; a
`propose_change` opens a pull request. Peter reviews on GitHub, from the phone if he likes, and
merges or closes. The server serves the merged recipe within minutes. A client gets write access only
if Peter granted it when connecting, so Muse can be read-only while claude.ai can propose.

**Alternative, if review proves too slow:** direct commits, each one revertible. Not recommended for
version 1: one bad write would change every assistant at once.

## Local agents

The repository is cloned at `~/code/milton`. Each recipe that is also a skill is linked into
`~/.agents/skills` (and from there into Claude Code, Codex and Pi, as skills are today), so local
agents read the same files the server serves. A `git pull` brings merged changes down; there is no
sync script and no second copy.

`~/.agents` keeps what only coding agents need: project rules, tools, memory. The memory brief's
`USER.md` rules stay there for coding sessions; where a rule also belongs in working-style, the recipe
holds the full version and `USER.md` keeps a one-line pointer, so the two don't drift.

## How it is built

- **Repository** `ptshih/milton` (Peter's personal account): `recipes/<name>/SKILL.md`, `inbox.md`,
  the Worker's code in `server/`, and pull requests for proposed changes.
- **Cloudflare Worker** with the Cloudflare Agents MCP handler (`createMcpHandler` on MCP SDK v2, no
  Durable Object) and the Workers OAuth Provider library. Version 1 bundles the recipes into the Worker
  at deploy time from `recipes/`, so a merged change ships with the next deploy. Reading and writing the
  repository as the GitHub App `milton-assistant`, narrowed to that one repository (contents and pull
  requests) with a short cache, comes with the write tools, which need the App anyway.
- **Sign-in:** OAuth with GitHub as the login, allowed for Peter's GitHub account only (login and
  numeric id), with dynamic client registration for claude.ai. The login goes through one GitHub
  App, `Milton (local)`, registered only to say who is signing in, with no repository permissions.
  A GitHub App takes several callback URLs, so the same app serves `http://localhost:8787/callback`
  and `https://mcp.meetmilton.com/callback`. Its id and secret live in the Worker's secrets, locally
  in the ignored `server/.dev.vars`. For clients that only take a key (possibly Muse), one revocable
  token per client, checked by the same server. Scopes `read` and `write` per client.
- **Address:** `mcp.meetmilton.com`, on the Cloudflare DNS that already serves `meetmilton.com`.
- **Reused later, not in version 1:** the Google Cloud key for Gemini (for features such as
  summarizing the inbox); the Vercel projects behind `meetmilton.com` and `app.meetmilton.com`. The
  Neon database is exported, then retired.

## Cost

Cloudflare's free tier (100,000 requests a day, plus the key-value store the sign-in needs) and a
free private GitHub repository: likely $0 a month at this volume.

## Build order

1. Archive the old Milton (tag, branches, uncommitted work as patches), clear `main`, then add the
   recipes: email-voice moved in and linked back into `~/.agents/skills`, and working-style drafted
   for approval.
2. The read-only server: built, reviewed, signed into locally with Claude Code as the client and
   deployed at `mcp.meetmilton.com` (2026-10-29); connect claude.ai and test on web and iPhone.
3. Connect Muse, ChatGPT and Grok; add the per-client token if any of them needs it.
4. The write tools: inbox notes and pull requests.
5. A standing instruction in each app where the server's own instruction isn't enough.

Each step ends with a check: the client drafts an email with the recipe and the result follows it
(read); a proposed change opens a pull request and, once merged, is served and appears locally after
a pull (write).

## Decisions for Peter

1. **Writing:** review queue as above (recommended), or direct commits.
2. **The working-style recipe:** approve its text before it is published.
3. **Claude Duet:** what it is and how it connects.

## Not in version 1

Anything about employers; memory facts; letting agents delete recipes; a web page for browsing recipes
(GitHub already shows them); Obsidian (it can open the `recipes` folder as a vault later).

## Version 2: Milton for anyone

_Decided with Peter on 2026-10-29, after version 1 went live, with two skeptic reads; he chose
direct writes and one shared database the same day. Nothing of this is built._

### Decisions taken

- **Anyone can use Milton.** Sign-in with GitHub now, Google next; any account, not only Peter's.
- **Recipes live in Milton's own store**, not in each user's repository. A download of the recipes
  as Markdown is a feature, not the source.
- **People and their assistants both write.** A person edits in Milton's web page. An assistant uses
  tools: it may create and update a recipe, and archive one, never delete. Every write records which
  client made it.
- **Every version is kept**, and a person can put any earlier one back in one tap. That makes an
  assistant's write recoverable, not safe: a write is live in every connected assistant at once, and
  history cannot undo an email already sent on a bad recipe. The page shows what changed so a bad write
  is noticed.
- **Peter is a user like any other.** His recipes move into the store. The repository keeps the
  code and the templates. His local agents read his recipes from the production server over MCP,
  like every other assistant; there is no copy in the repository or in `~/.agents/skills` (Peter,
  2026-10-29). At the cutover the `email-voice` and `working-style` skill links and `recipes/` are
  removed, so no agent reads a stale copy beside the live one.

### Naming: recipes

Everything Milton holds is a **recipe**, in the product, the code and the database (Peter,
2026-10-29). The tools are `list_recipes`, `get_recipe(name)`, `get_vibes` and `search`; the
working-style template is named `vibes`, the one recipe about the person rather than a task, served by `get_vibes` and downloaded as `VIBES.md`, the way `AGENTS.md` describes a repository; the page says "Your recipes", "New recipe" and
"Download all". The humour is cooking slang, not a kitchen: "Then let them cook" on the home page,
"We're cooking now!" after an assistant connects, "Chef's kiss" after a save, "We're cooked." on an
error page. Security screens, tool descriptions, the standing instruction and anything an assistant
reads stay plain. The rename ships with the switch to store reads, when clients re-authorize anyway.

The theme is a wink at vibe coding and "cooking" (Peter, 2026-10-29). Vibe coding is mocked for
having no rules; Milton writes the vibes down so assistants follow them, and the product underneath
is rigorous: every version kept, one-tap revert, caps. Starting lines for the home page and
onboarding: "Vibe coding, but the vibes are in writing.", "Your vibes, in every assistant.", "Stop
re-explaining your vibes.", "Then let them cook." The jokes stay on the surface and never in the
substance, so they read as self-aware, not careless.

### What a user gets

One Milton account, created at first sign-in. A set of recipes, seeded from the templates
(`email-voice`, `vibes`, both empty but for their headings). A connector address,
`https://mcp.meetmilton.com/mcp`, the same for everyone; the token says whose recipes are served.
The web page at `https://app.meetmilton.com/` (the MCP host redirects pages there): sign in, the recipes, each one's history with revert,
archived recipes, the clients connected and their grants, usage against the caps, and a download of
all current recipes as a zip of `SKILL.md` folders.

### Recipes

A recipe is a name, a description and a Markdown body. The name is a slug, fixed for the recipe's
life (no rename in version 2); the description is one line; the body is the text assistants read.
The downloaded `SKILL.md` is generated from the three, with valid frontmatter. A recipe has a current
version number, and every version keeps its text, who wrote it (person or client), when, and a
reason. Archiving and restoring are versions too: each flips the archived flag with the text unchanged, which is not a revert. An archived recipe is left out of `list_recipes`,
`search` and `get_vibes`; `get_recipe` returns it marked archived. Only the person, on the page,
can delete a recipe or the whole account, with a typed confirmation; a delete removes the recipe and its history. Deleting an account also revokes its sessions and grants. Neon's point-in-time history keeps deleted data until its retention window passes.

### Tools

| Tool                                                               | What it does                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `list_recipes`, `get_recipe(name)`                                   | As in version 1, for the caller's recipes; each answer carries the version                              |
| `get_vibes`                                                  | The caller's vibes recipe                                                                         |
| `search(words)`                                                    | Across the caller's recipes                                                                             |
| `create_recipe(name, description, text)`                            | A new recipe at version 1; fails if the name exists                                                     |
| `update_recipe(name, text, reason, expected_version, description?)` | A new version, only if `expected_version` (the version tag a read returned) is still current; otherwise a conflict with the current text |
| `archive_recipe(name, reason, expected_version)`                    | Hides the recipe; same check                                                                            |

Reads return a version tag that encodes the recipe's immutable id and version number, so a tag for a deleted and recreated recipe never matches (Peter, 2026-10-30). A write answers with the committed version and text. A retried write cannot apply twice: its
`expected_version` is no longer current after the first succeeds, so it gets a conflict with the
current text. After a revert on the page, an assistant's conversation is stale until it
reads again; the standing instruction says so. No delete and no revert for assistants; those need a signed-in browser session on the page. The page's own edits, revert and restore go through the same atomic check and commit as the tools: each names the version it expects. A revert appends a new, higher-numbered version copied from the chosen one, keeps the versions in between, and records which version it came from.

The standing instruction gains one line: "When the person states a durable preference, save it with
`update_recipe` and say what you changed."

### Who may write

For the MVP every assistant the person connects can read and write (Peter, 2026-10-29). Neon Auth's
managed OAuth provider has fixed scopes (`openid`, `profile`, `email`, `offline_access`), so there is
no `read` or `write` scope to grant: a valid access token for Milton's resource from an admitted user
is the permission. Assistants still cannot delete or revert, every write is a kept version, and the
page shows each write with its client. Per-client permissions, stored in Milton and switched on the
page, are the later answer if they are wanted. Cutting a disconnected assistant off before its
token expires is after the MVP (TODO #1). The page has its own
signed-in browser session (expiry, logout, request forgery protection), separate from the OAuth
provider's transient cookies; revert, delete and identity linking need it. Recipe text is rendered
as text, never as HTML.

### Identity

A Milton user has an immutable id of its own, with no colon in it, and one or more identities:
`github` with GitHub's numeric id today, `google` with Google's `sub` later, never an email address.
The registry maps (provider, subject) to a user uniquely and transactionally: concurrent first
sign-ins cannot create two accounts or link one identity to two users; seeding
the templates is repeatable. The OAuth provider's token carries the Milton user id, and every tool
reads the caller from it. Sign-in is split in two: the provider step proves an identity; the account
step looks it up or admits it. A second identity is linked only by a signed-in user from the page,
with the provider, the session and the intended account held server-side during the flow; an identity
already owned by another user is refused. Closing sign-ups never locks out an existing user.

### Tenant boundary

Every request derives one store accessor from the validated Milton user id in the token or the page
session, and nothing else: no caller-supplied user id, no shared recipe cache, no global recipe
collection as version 1 has. Reads, search, history, downloads and the page all go through that
accessor. A store that cannot run a cross-user query would be a second wall; version 2 relies on the access
layer, and revisits per-user stores later (decision 2).

### Caps, not logs

Per user: 100 recipes including archived ones, 32 KB of UTF-8 body text, a name of up to 64 bytes and a
description of up to 500 bytes, 500 bytes of reason, 1,000 tool calls and 200 writes a day, reset at midnight UTC. Request bodies are capped at 64 KB before parsing; list, search and history answers come in pages of 50. The daily allowance counts MCP calls; the page has no request limit of its own in the MVP. Retained history is counted in bytes per user and capped at 64 MB; past the cap new text is refused with a clear message, while reverts and restores still go through and do not count against the daily writes, so recovery is never blocked; history is never discarded silently. Per-minute and per-address limits are left to the
host's firewall, and client registration to Neon Auth. The OAuth provider's own lifetimes apply to client
registrations and grants; the page lists the user's grants and revokes them, and never deletes a
client registration another user may share. The caps are configuration.

### Download

The page offers one download: a zip with `VIBES.md` at the top and the current, unarchived recipes, each a `SKILL.md` folder in
the Agent Skills format, built from one consistent snapshot. There is no export to GitHub and no
local copy kept in step; an assistant that needs the recipes connects to the server (Peter,
2026-10-29).

### Decision 1: when an assistant writes

- A. **Direct and versioned.** The write is current at once. The page keeps every version, lists the
  changes, and one tap puts an older one back. Cost: a bad write is live everywhere until noticed.
- B. **Held until seen.** The write waits as a pending version until the person accepts it on the
  page. Cost: every assistant write needs a tap, and an assistant cannot rely on its own change.

Chosen: A. B comes back only if use shows a need, which is how Peter decides new rules.

### Decision 2: where a user's recipes live

- A. **One Durable Object per user**, each with its own SQLite database. Stronger separation of recipe
  storage: no SQL query can span users. Cost: per-object schema changes, a registry to walk.
- B. **One shared database** with the user id on every row behind a mandatory tenant access layer.
  Simpler to run and to change at a few hundred users.

Chosen: B, as one Postgres database on Neon (decided 2026-10-29, after a first landing on Cloudflare
D1 the same evening). Peter's reason for B was rapid iteration on the data model; Neon adds real
transactions, branches to try a schema change on a copy, Drizzle migrations and the Neon tooling the
team already uses. The Worker reaches it over the network with a connection string held as a secret.
The tenant access layer is the wall, and the same layer makes a later move to A mechanical. The
stateless MCP handler stays. Neon Functions were looked at and left for later: in beta, and Milton's
sign-in rests on Cloudflare's OAuth provider.

### Recovery

Neon's point-in-time history for the whole branch is the backup (the retention is a project setting).
A separate daily export waits until there are users enough to need it (Peter, 2026-10-29).
Rehearsals run on a throwaway Neon branch made from production and deleted afterwards, never on the
production branch. Before sign-ups open, a rehearsal with two users on Vercel's preview checks
isolation, concurrent edits with conflicts, retries, revert, archive, delete and old-token handling.

### Cost

Neon is already on a paid plan (Peter, 2026-10-29), and the server runs on an existing Vercel plan, so
sign-ups add no new bill. Workers Paid is not needed: the Worker and its key-value store retire with
the moves to Neon Auth and Vercel, both before sign-ups open.
No sign-up cap anywhere, hosted or self-hosted (Peter, 2026-10-30). Admission modes remain closed, allow-list, or open; fresh installs default to closed.

### Sign-in moves to Neon Auth

Decided 2026-10-29, after the store moved to Neon: Milton stops running its own OAuth server. Neon's
Managed Better Auth, with its OAuth provider plugin (beta since 2026-10-23), is the authorization
server for `https://mcp.meetmilton.com/mcp`. MCP clients onboard with Client ID Metadata Documents,
and dynamic client registration is switched on for the clients that need it. Users live in the Neon
project beside the recipes; GitHub login is a provider toggle there, Google another. The Worker
becomes a resource server: it checks each access token's signature, issuer and audience and reads
the user from it; the OAuth provider library, the KV namespace, the GitHub upstream code and the
consent handshake go. Milton hosts the two pages Neon does not provide, login and consent, on the
Worker, in Milton's look. Admission stays in Milton, keyed on the Neon user id.
Every client re-authorizes once. The previous sign-in code stays in git as the fallback while the
beta settles.

Order: the store port lands first, then this, as its own step, before the write tools, so write
scopes are designed once.

### The server moves to Vercel

Decided 2026-10-29, as the step after sign-in moves to Neon Auth. Once the Worker is only the MCP
server, the tools, the tenant store on Neon, token verification and two pages, it is plain Node code
and runs as a Vercel Function in this repository, next to the site: Vercel's MCP handler or the SDK's
own transport, the same host and origin checks, the pages as routes, the Neon connection string and
issuer as sensitive environment variables. `mcp.meetmilton.com` is repointed from the Worker to
Vercel; the MCP server URL registered with Neon Auth does not change. Then the Worker, the KV
namespace and the Wrangler configuration are deleted, and Cloudflare keeps DNS only.

Milton stays on an existing Vercel team for now (Peter, 2026-10-29); a Milton team of its own comes
when Milton has users worth the plan. Order: store port, Neon Auth, then this, straight after (Peter, 2026-10-29).

### Migration from version 1

Production cuts over once, after the store, Neon Auth and the Vercel move are all built (Peter,
2026-10-29). Until then it stays on version 1, the Worker with bundled recipes.

1. Build the store, Neon Auth sign-in and the Vercel Function. Production keeps reading the bundled recipes.
2. On Vercel, Peter signs in, which creates his account; his two recipes are imported, and the import is checked
   against the files byte for byte.
3. Reads switch to the store. Version 1 tokens carry a GitHub id and not a Milton user id, so they
   stop working and clients re-authorize once; the bundle is removed only after reads are verified.
4. Write tools, history and revert, enabled only once the page's revert works.
5. Privacy policy and terms pages on `meetmilton.com` (done 2026-10-30; Google brand verified, so its screen says "continue to Milton"); sign-ups opened; onboarding on `meetmilton.com`.

There is no rollback plan (Peter, 2026-10-29): once the Vercel deployment is verified, the retired pieces (Worker, KV, Wrangler configuration, old sign-in code) are deleted as the work moves on. A disaster restore uses Neon's point-in-time history and names its recovery point. Neither redeploys the bundled recipes over newer writes.

### A principle: recipes are portable

A recipe is a plain Markdown file in the Agent Skills format, readable by any tool that loads
skills. Everything Milton adds, history, authorship, caps, usage, lives beside the file, never inside
it. Download, import and a per-client token for products that cannot speak MCP are that principle
applied. Milton must never grow a feature that makes a recipe work only inside Milton.

And a recipe is an instruction, never memory. Facts about projects, people and events belong to the
memory products, a crowded market Milton stays out of; a recipe says how the person wants a kind of
thing done. Tools, templates and copy keep to that side of the line.

### Teams later

Recipes belong to the user directly; there is no owner layer in version 2 (Peter, 2026-10-29). Teams
get their own design when they are wanted: members, roles, sharing and whose vibes apply.

### After the six steps, in this order

1. **Import as onboarding.** A new user pastes or uploads their existing custom instructions or a
   memory export from ChatGPT, Claude or Gemini, and Milton drafts their first vibes recipe
   from it, for them to edit. An empty account becomes useful in a minute.
2. **Search that finds meaning.** All-words matching replaces the literal phrase first; semantic search
   through Workers AI embeddings follows.
3. **Links between recipes.** A recipe can point at another ("see email-voice") in a form the tools
   follow, so an assistant picks the right recipe.
4. **A recipe as a page for a person.** The same recipe rendered read-only at a link you can send, for
   a new colleague or a contractor.
5. **Recipes as tests.** Score a draft against the recipes it should follow, and tell the person which
   assistant drifts; needs the write tools, history and a model call.
6. **Policy for agents that act.** Recipes that say what an assistant may do without asking: limits,
   contacts, when to stop. The same object, read before an action rather than before a draft.

Looked at and left out: automatic extraction of memories from conversations and background rewriting
of them, which would have assistants follow things the person never said; knowledge graphs and
connectors to mail or drives, off the thesis at ten recipes a person.

### Not in version 2

Sharing recipes between users, teams, payment, Claude Duet, a recipe format other than Markdown,
renaming a recipe.
