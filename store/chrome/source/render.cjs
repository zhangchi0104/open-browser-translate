// Renders the store images and extension icons from the sources in this folder.
// Needs Playwright with Chromium: `npm i -g playwright && npx playwright install chromium`, then
//   NODE_PATH="$(npm root -g)" node store/chrome/source/render.cjs [icons|promo|all]
// Screenshots come from the running extension instead: see capture-screenshots.cjs.
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const here = __dirname;
const root = resolve(here, "../../..");
const store = resolve(here, "..");

// Toolbar sizes drop most of the padding so the mark stays legible; 96 and 128 keep the
// 16/128 transparent margin the Chrome Web Store asks of its icon.
const icons = [
  ...[16, 32, 48].map((size) => ({ size, viewBox: "14 14 100 100", out: `${root}/public/icon/${size}.png` })),
  ...[96, 128].map((size) => ({ size, viewBox: "0 0 128 128", out: `${root}/public/icon/${size}.png` })),
  { size: 128, viewBox: "0 0 128 128", out: `${store}/icon-128.png` },
];
const promos = [
  { file: "promo-small.html", width: 440, height: 280, out: `${store}/promo-small-440x280.png` },
  { file: "promo-marquee.html", width: 1400, height: 560, out: `${store}/promo-marquee-1400x560.png` },
];

async function main(which) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    if (which === "icons" || which === "all") {
      const svg = readFileSync(`${here}/icon.svg`, "utf8");
      for (const { size, viewBox, out } of icons) {
        const page = await browser.newPage({ viewport: { width: size, height: size } });
        const sized = svg.replace(/width="128" height="128" viewBox="[^"]*"/, `width="${size}" height="${size}" viewBox="${viewBox}"`);
        await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: out, omitBackground: true });
        await page.close();
        console.log(out);
      }
    }
    if (which === "promo" || which === "all") {
      for (const { file, width, height, out } of promos) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(`file://${here}/${file}`);
        await page.evaluate(() => document.fonts.ready);
        // Promo tiles must be opaque: no transparency in Chrome Web Store promotional images.
        await page.screenshot({ path: out, type: "png" });
        await page.close();
        console.log(out);
      }
    }
  } finally {
    await browser.close();
  }
}

main(process.argv[2] ?? "all").catch((error) => { console.error(error); process.exit(1); });
