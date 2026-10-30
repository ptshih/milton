# Milton: instructions for agents

Milton holds Peter's recipes (how he wants things done) and will serve them to every assistant he
uses through a private MCP server. [SPEC.md](SPEC.md) is the plan and the order of work; the
[README](README.md) says what is here.

## Stop first

- **Recipes are served to outside assistants.** Every recipe is served to claude.ai,
  ChatGPT, Muse and others. Never put anything about employers, investors, customers, secrets or other people's private details in a recipe, a fixture, a commit message or a
  log.
- **Recipes change only through Peter.** Assistants save what he tells them through Milton's write
  tools; every write is a kept version he can revert on the page. Never edit his recipes on your own
  initiative.
- **Peter's recipes live on the server.** Claude Code, Codex and Pi read them from the Milton MCP
  server (`https://mcp.meetmilton.com/mcp`). Change recipes through Milton, not by editing files;
  the repository holds only the starter templates.
- **A push publishes.** Push only when Peter asks. Neither Vercel project (`milton-site` for
  `meetmilton.com`, `milton-mcp` for `mcp.meetmilton.com`) deploys on a push; deploys run from
  the command line.
- **Secrets stay out of git.** Keys and environment files belong in Vercel's environment
  variables or in `.env.local`, which is ignored.

## Working

- Use Bun. Run `bun run check-types` and `bun test` before you hand work back, and report the exit
  codes.
- Keep Milton's look: build pages and any screens from `packages/theme`, and keep the contrast test
  passing.
- One change per commit, by explicit path. Never `git add -A`, `reset --hard`, `stash`, `clean` or
  `rebase`.
