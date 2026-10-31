# Milton theme assets

`base.css` owns the shared light/dark palette, typography, and basic controls.
The site forces light; the app follows the system. `contrast.test.ts` checks
text pairs, functional borders, and the two matching dark declarations.

The font masters in `public/fonts` are self-hosted, with their upstream licenses:

- `source-serif-4-semibold.woff2`: Source Serif 4, upright 600, from
  https://raw.githubusercontent.com/adobe-fonts/source-serif/release/WOFF2/OTF/SourceSerif4-Semibold.otf.woff2
- `jetbrains-mono-regular.woff2`: JetBrains Mono, upright 400, from
  https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/webfonts/JetBrainsMono-Regular.woff2

These are the weights used by the design. Both use `font-display: swap` and
local fallbacks. The server build and Astro config copy the same masters into
their own public directories; neither makes a runtime font-service request.

`brand.ts` owns the plain folder SVG, used inline and emitted as the public
favicon. App pages keep `img-src 'none'` and use the inline mark; the public site
links the favicon. Only the app's font CSP source changes to `'self'`.
`server/scripts/assets.ts` mirrors the exact built asset URLs for local servers;
Vercel serves the server's `public` directory in production.
