import { defineConfig } from "astro/config";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { folderMark } from "../../packages/theme/brand.ts";

// Build and dev serve the same local masters as the app. No runtime font service.
const publicDirectory = new URL("./public/", import.meta.url);
mkdirSync(publicDirectory, { recursive: true });
cpSync(
  new URL("../../packages/theme/public/", import.meta.url),
  publicDirectory,
  { recursive: true },
);
writeFileSync(new URL("favicon.svg", publicDirectory), folderMark);

export default defineConfig({
  site: "https://www.meetmilton.com",
  output: "static",
  devToolbar: { enabled: false },
  vite: { server: { strictPort: true } },
});
