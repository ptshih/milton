import { mkdir, readFile, writeFile } from "node:fs/promises";

const theme = await readFile(
  new URL("../../packages/theme/base.css", import.meta.url),
  "utf8",
);
const pages = await readFile(
  new URL("../src/pages.css", import.meta.url),
  "utf8",
);
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../public/milton.css", import.meta.url),
  `${theme}\n${pages}\n`,
);
console.log("Built Milton's stylesheet from packages/theme.");

const bundle = await Bun.build({
  entrypoints: [new URL("../src/function.ts", import.meta.url).pathname],
  outdir: new URL("../dist/", import.meta.url).pathname,
  naming: "milton.js",
  target: "node",
  format: "esm",
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  throw new Error("Bundling the Vercel Function failed.");
}
console.log("Bundled the Vercel Function into dist/milton.js.");
