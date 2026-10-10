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
  // Tailwind only processes stylesheets that import it: the options page and the content script UI.
  vite: () => ({ plugins: [tailwindcss()] }),
  webExt: { chromiumProfile, keepProfileChanges: true },
  // AMO reviewers rebuild from the sources ZIP, which needs the workspace root's package.json and
  // bun.lock; the site and the store images aren't part of the extension.
  zip: {
    sourcesRoot: resolve("../.."),
    excludeSources: ["apps/site/**", "store/**", "docs/**", "**/node_modules/**", "**/.output/**"],
  },
  manifest: ({ browser, manifestVersion }) => ({
    // Name and description come from public/_locales; the Chrome Web Store shows them as each
    // language's listing title and summary (at most 132 characters).
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    permissions: ["storage"],
    // No popup: the toolbar button opens the settings page (see background.ts).
    action: { default_title: "__MSG_actionTitle__" },
    host_permissions: ["https://ai-gateway.vercel.sh/*", "https://api.openai.com/*",
      // Sign in with ChatGPT: token exchange, and reading the code from the loopback callback tab.
      "https://auth.openai.com/*", "http://127.0.0.1/*"],
    // Custom connections reach any OpenAI-compatible server; the settings page asks for its origin on save.
    // Manifest V2 (Firefox) has no optional_host_permissions and lists host patterns as permissions.
    ...(manifestVersion === 2
      ? { optional_permissions: ["https://*/*", "http://*/*"] }
      : { optional_host_permissions: ["https://*/*", "http://*/*"] }),
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          // AMO ties the listing and its updates to this ID; it can't change once published.
          id: "open-browser-translate@zhangchi0104",
          // Firefox's built-in data consent, required of new AMO listings. Page text goes to the
          // model the reader configures; 140 is the first version that asks for that consent.
          data_collection_permissions: { required: ["websiteContent"] },
          strict_min_version: "140.0",
        },
        gecko_android: { strict_min_version: "142.0" },
      },
    }),
    // Safari builds as Manifest V3 (`--mv3`, see package.json). 16.4 brings storage.session, which
    // the ChatGPT sign-in keeps its pending attempt in, and the CSS that Tailwind 4 needs.
    ...(browser === "safari" && {
      browser_specific_settings: { safari: { strict_min_version: "16.4" } },
    }),
  }),
});
