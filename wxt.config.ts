import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const chromiumProfile = resolve(".wxt/chrome-data");
// web-ext requires the persistent profile directory to exist before launch.
mkdirSync(chromiumProfile, { recursive: true });

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "./src",
  modules: ["@wxt-dev/module-react"],
  // Tailwind only processes stylesheets that import it; today that is the options page.
  vite: () => ({ plugins: [tailwindcss()] }),
  webExt: { chromiumProfile, keepProfileChanges: true },
  manifest: {
    permissions: ["storage"],
    // No popup: the toolbar button opens the settings page (see background.ts).
    action: { default_title: "翻译设置" },
    host_permissions: ["https://api.typesafe.ai/*", "https://ai-gateway.vercel.sh/*", "https://api.openai.com/*",
      // Sign in with ChatGPT: token exchange, and reading the code from the loopback callback tab.
      "https://auth.openai.com/*", "http://127.0.0.1/*"],
  },
});
