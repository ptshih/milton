# Milton

Your vibes, in every assistant. Write down once how you like things done, and every AI assistant
you connect reads it before it works for you: Claude, ChatGPT, Claude Code, Codex, Cursor, and any
other MCP client.

I built Milton because I was tired of telling Claude to stop using em dashes for the 100th time.

Milton is named after Milton Waddams in Office Space, the collator: he keeps things in order and
hands over the right one.

## How it works

- **Recipes.** Your instructions live as a few short recipes in the Agent Skills format: `vibes`
  for how you want any assistant to work with you, plus one per thing you do your way, like
  `email-voice`.
- **One MCP server.** Assistants connect to `https://mcp.meetmilton.com/mcp` and read your recipes
  with `list_recipes`, `get_recipe`, `get_vibes`, and `search`. They save what you tell them with
  `create_recipe`, `update_recipe`, and `archive_recipe`.
- **Every version is kept.** Each write is a new version that records which assistant made it. The
  web page at `https://app.meetmilton.com` shows the history with diffs, and one tap reverts.
  Assistants cannot delete or revert; only you can.

The hosted service is at [meetmilton.com](https://meetmilton.com), in early access.

## What is here

- [`server/`](server/): the MCP server and web app, a Vercel Function on Node 24. Sign-in is Neon
  Auth (Google and GitHub); recipes live in Neon Postgres. See its README to run your own.
- [`apps/site`](apps/site/): the Astro page behind `meetmilton.com`.
- [`packages/theme`](packages/theme/): Milton's design tokens, stylesheets, and contrast check.
- [`templates/`](templates/): the starter recipes every new account gets.
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
