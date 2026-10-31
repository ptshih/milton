# Milton

Your vibes, in every assistant. Write down once how you like things done, and every AI assistant
you connect reads it before it works for you: Claude, ChatGPT, Claude Code, Codex, Cursor, and any
other MCP client.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **Tell Milton how to work.** Your connected assistant submits instructions,
  corrections or removal requests with `save_memo`. Milton's LLM organizes the
  internal memos and compiles all active instructions into TPS Report.
- **Read one report.** `get_tps_report` returns the prepared report without a model
  call. Assistants apply its instructions and exceptions to their own work.
- **See what's on file.** The app shows your current TPS Report and downloads it
  as `TPS.md`. New accounts start empty. For first setup, review and approve the
  complete draft before your assistant saves it.
- **Keep the filing internal.** Memos retain their version history internally.
  TPS is a current compiled snapshot with a revision token, not a second history
  or restore interface. A save publishes memo changes and TPS together.

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
