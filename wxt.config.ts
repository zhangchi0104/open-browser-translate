import { defineConfig } from "wxt";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const chromiumProfile = resolve(".wxt/chrome-data");
// web-ext requires the persistent profile directory to exist before launch.
mkdirSync(chromiumProfile, { recursive: true });

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "./src",
  webExt: { chromiumProfile, keepProfileChanges: true },
  manifest: {
    permissions: ["storage"],
    host_permissions: ["https://api.typesafe.ai/*", "https://ai-gateway.vercel.sh/*", "https://api.openai.com/*"],
  },
});
