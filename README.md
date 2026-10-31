# Milton

Your vibes, in every assistant. Write down once how you like things done, and every AI assistant
you connect reads it before it works for you: Claude, ChatGPT, Claude Code, Codex, Cursor, and any
other MCP client.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **TPS Report and memos.** TPS Report holds your general working preferences. Ordinary
  memos hold instructions for particular tasks, in the portable Agent Skills format.
  A new account starts with empty TPS; existing content stays intact.
- **One MCP server.** Assistants connect to `https://mcp.meetmilton.com/mcp`. They read
  `get_tps_report`, `list_memos`, `get_memo`, and `search`; `tps_check` guides a complete
  draft for your approval. They author content with `update_tps_report`, `create_memo`,
  and `update_memo`. `archive_memo` stops serving an ordinary memo to assistants.
- **Draft checks.** `check_draft` supplies TPS Report, an optional named memo, and a
  review guide. Your assistant judges the draft against those rules; Milton makes
  no model call and does not save the draft.
- **Every version is kept.** The read-only app at `https://app.meetmilton.com` shows
  content, history, and diffs. You can archive or restore ordinary memos and restore a
  stored version of any memo, including TPS, as a new version. TPS stays active.
  Download all exports one root `TPS.md` and active ordinary `<name>/SKILL.md` folders.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## What is here

- [`server/`](server/): the MCP server and web app, a Vercel Function on Node 24. Sign-in is Neon
  Auth (Google and GitHub); memos live in Neon Postgres. See its README to run your own.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`templates/`](templates/): the empty TPS template for new accounts.
- [`design/`](design/): Milton's portrait and icons.
- [`SPEC.md`](SPEC.md): the design notes and decisions, in the order they were made.

## Working locally

```sh
bun install
bun run check-types
bun test
bun run dev      # the site, through Astro
```

## License

[MIT](LICENSE), © 2026 Zone of Danger, LLC.
