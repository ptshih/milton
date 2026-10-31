# Milton: instructions for agents

Milton maintains internal memos containing working instructions and serves their compiled
TPS Report to connected assistants through its MCP server. [SPEC.md](SPEC.md) is the plan and the order of work; the
[README](README.md) says what is here.

## Stop first

- **Memos are served to outside assistants.** Every memo is served to claude.ai,
  ChatGPT, Muse and others. Never put anything about employers, investors, customers, secrets or other people's private details in a memo, a fixture, a commit message or a
  log.
- **Memos change only through Peter.** Assistants submit user-directed instructions through `save_memo`; Milton organizes
  internal memos and compiles TPS in one atomic save. Memo history stays internal;
  TPS has only a current snapshot and revision token. Never edit live memos on your own initiative.
- **Peter's memos live on the server.** Claude Code, Codex and Pi read them from the Milton MCP
  server (`https://mcp.meetmilton.com/mcp`). Change memos through Milton, not by editing files;
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
