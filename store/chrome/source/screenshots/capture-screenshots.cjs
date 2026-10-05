// Takes the store screenshots from the real extension: a build in .output/chrome-mv3, loaded
// into Chromium, translating a demo page. Both https://fieldnotes.example (the page) and
// https://api.openai.com resolve to a local server; as OpenAI it answers with the translations in
// translations.json, so no key or network is needed.
//
//   bun run build
//   sudo NODE_PATH="$(npm root -g)" node store/chrome/source/screenshots/capture-screenshots.cjs
//
// Needs Playwright (`npm i -g playwright`), openssl, and port 443. CHROMIUM_PATH picks a
// Chromium other than Playwright's.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const https = require("node:https");

const here = __dirname;
const root = resolve(here, "../../../..");
const out = resolve(here, "../..");
const extension = join(root, ".output/chrome-mv3");
const translations = JSON.parse(readFileSync(join(here, "translations.json"), "utf8"));
const missing = new Set();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// —— The model: a stand-in for OpenAI's Chat Completions ——

const MODELS = ["gpt-6-luna", "gpt-5", "gpt-5-mini"];
const NAV = new Set(["Articles", "Guides", "Podcast", "About", "Subscribe", "Fieldnotes"]);

function decide(body) {
  const { input, decisions } = JSON.parse(body.messages.at(-1).content);
  const answer = {};
  for (const [key, { options }] of Object.entries(decisions)) {
    const labels = Object.keys(options);
    let pick = labels.includes("main") ? "main" : labels.includes("single") ? "single" : "content";
    const block = input.blocks?.find((candidate) => candidate.id === key);
    if (block && NAV.has(block.text.trim())) pick = "navigation";
    if (block && /^By .* min read$/.test(block.text.trim())) pick = "auxiliary";
    answer[key] = { probabilities: Object.fromEntries(labels.map((label) => [label, label === pick ? 0.94 : 0.06 / (labels.length - 1)])) };
  }
  return JSON.stringify(answer);
}

function translate(body) {
  const { blocks } = JSON.parse(body.messages.at(-1).content);
  return JSON.stringify({
    translations: blocks.map(({ id, text }) => {
      if (!translations[text]) missing.add(text);
      return { id, text: translations[text] ?? `【缺少译文】${text}` };
    }),
    terms: [],
  });
}

const SITE = "fieldnotes.example";
const page = readFileSync(join(here, "demo-article.html"));

function serve(request, response) {
  if (request.headers.host === SITE) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(page);
  }
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", async () => {
    if (request.url.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ object: "list", data: MODELS.map((id, index) => ({ id, object: "model", created: 1_790_000_000 - index, owned_by: "openai" })) }));
    }
    const body = JSON.parse(raw);
    const system = body.messages[0].content;
    const content = system.startsWith("You answer multiple-choice decisions") ? decide(body) : translate(body);
    const base = { id: "chatcmpl-demo", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model };
    const usage = { prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (chunk) => response.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...chunk })}\n\n`);
    for (let index = 0; index < content.length; index += 24) {
      send({ choices: [{ index: 0, delta: { content: content.slice(index, index + 24) }, finish_reason: null }] });
      await sleep(8);
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
    response.end("data: [DONE]\n\n");
  });
}

function certificate() {
  const dir = mkdtempSync(join(tmpdir(), "obt-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${SITE}`,
    "-addext", `subjectAltName=DNS:api.openai.com,DNS:${SITE}`, "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

// —— The browser ——

const SETTINGS = {
  targetLanguage: "zh-CN",
  connections: [
    { id: "VercelAIGateway", kind: "VercelAIGateway", name: "Vercel AI Gateway", apiKey: "" },
    { id: "OpenAIApi", kind: "OpenAIApi", name: "OpenAI", apiKey: "sk-proj-demo-0000000000000000000000000000" },
  ],
  analysis: { connection: "OpenAIApi", models: { VercelAIGateway: "typesafe-ai/jev", OpenAIApi: "gpt-6-luna" } },
  translation: { connection: "OpenAIApi", models: { OpenAIApi: "gpt-6-luna" } },
};

async function main() {
  if (!existsSync(join(extension, "manifest.json"))) throw new Error("Build the extension first: bun run build");
  const server = https.createServer(certificate(), serve).listen(443);
  const profile = mkdtempSync(join(tmpdir(), "obt-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH && { executablePath: process.env.CHROMIUM_PATH }),
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP api.openai.com 127.0.0.1, MAP ${SITE} 127.0.0.1`, "--ignore-certificate-errors", "--no-proxy-server", "--lang=zh-CN",
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    // Seeded through the options page, which has the extension's storage API.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.evaluate((settings) => chrome.storage.local.set({ aiSettings: settings, aiSettings$: { v: 5 } }), SETTINGS);
    await options.close();
    await shoot(context, id);
  } finally {
    if (missing.size) {
      writeFileSync(join(tmpdir(), "obt-missing.json"), JSON.stringify(Object.fromEntries([...missing].map((text) => [text, ""])), null, 2));
      console.warn(`${missing.size} texts have no translation; see ${join(tmpdir(), "obt-missing.json")}`);
    }
    await context.close();
    server.close();
  }
}

async function shoot(context, id) {
  const shot = (page, name) => page.screenshot({ path: join(out, `screenshot-${name}.png`) }).then(() => console.log(`screenshot-${name}.png`));

  // 1. The article, translated in place. Scrolling through it lets the session reach every block.
  const article = await context.newPage();
  await article.goto(`https://${SITE}/2026/10/what-to-paint-first`);
  await sleep(1000);
  await article.getByRole("button", { name: "翻译此页" }).click();
  for (let step = 0; step < 6; step++) { await article.mouse.wheel(0, 400); await sleep(700); }
  await article.evaluate(() => scrollTo(0, 0));
  await sleep(1500);
  await shot(article, "1-inline-translation");

  // 2. Further down, with the launcher's quick settings open.
  await article.evaluate(() => scrollTo(0, document.querySelector("h2").offsetTop - 40));
  await sleep(800);
  await article.getByRole("button", { name: "翻译此页" }).hover();
  await article.getByRole("button", { name: "翻译设置" }).click();
  await sleep(1200);
  await shot(article, "2-quick-settings");

  // 3–5. The settings page: models, connections, and the cache in the dark theme.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await sleep(1500);
  await shot(settings, "3-settings-models");
  await settings.getByRole("button", { name: "连接" }).click();
  await settings.getByRole("button", { name: "编辑" }).nth(1).click();
  await sleep(1000);
  await shot(settings, "4-settings-connections");
  await settings.emulateMedia({ colorScheme: "dark" });
  await settings.getByRole("button", { name: "翻译缓存" }).click();
  await sleep(1200);
  await shot(settings, "5-settings-cache-dark");
}

main().catch((error) => { console.error(error); process.exit(1); });
