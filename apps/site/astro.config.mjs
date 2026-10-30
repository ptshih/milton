import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.meetmilton.com",
  output: "static",
  devToolbar: { enabled: false },
  vite: { server: { strictPort: true } },
});
