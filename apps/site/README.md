# Milton landing page

The public site is a static Astro app with a home page, `/privacy` and `/terms`.
It shares the theme package and imports Milton's portrait from `design/milton.png`.
It has no server, database, browser JavaScript, or environment variables.

From the repository root:

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run --cwd apps/site dev
bun --no-env-file run --cwd apps/site check-types
bun --no-env-file run --cwd apps/site build
bun --no-env-file run --cwd apps/site format:check
```

Check that the default development port, 4321, is free before starting it. The
static build is written to `apps/site/dist`.

## Hosting

Vercel project `milton-site` serves `meetmilton.com`.
`meetmilton.com` redirects to `www.meetmilton.com` with HTTP 308. Cloudflare DNS
records point to Vercel with proxying disabled. Use the target returned by
Vercel's domain configuration for this project.

Project settings: Astro framework, root directory `apps/site`, build command
`bun run build`, output directory `dist`, and Node.js 24.x. This static site does
not need the Vercel Astro adapter.

The site pins TypeScript 6 because `astro check` does not support the root
workspace's TypeScript 7 yet.

Deploy from the repository root with the project explicitly selected:

```sh
vercel deploy --prod --project milton-site
```

Do not reuse the web app's project link or copy its environment variables.
