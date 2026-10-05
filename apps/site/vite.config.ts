import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Served by GitHub Pages at https://zhangchi0104.github.io/open-browser-translate/. Each page is its
// own HTML entry, so /privacy-policy/ is a plain file there and needs no client-side routing.
export default defineConfig({
  // pages.yml passes the base path actions/configure-pages reports, which follows a custom domain.
  base: process.env.SITE_BASE || "/open-browser-translate/",
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      input: {
        home: resolve(import.meta.dirname, "index.html"),
        privacy: resolve(import.meta.dirname, "privacy-policy/index.html"),
      },
    },
  },
});
