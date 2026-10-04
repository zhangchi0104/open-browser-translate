import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// ADR-0003: modules are grouped by where they run. The content script never reaches code that
// holds API keys or calls models, and shared modules depend on neither side.

const root = fileURLToPath(new URL("..", import.meta.url));

function sourcesIn(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/** Every module path a file imports, relative to the repo root. */
function importsOf(file: string): string[] {
  const text = readFileSync(join(root, file), "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']((?:\.{1,2}\/|@\/)[^"']+)["']/g)].map(([, spec]) =>
    spec!.startsWith("@/") ? normalize(join("src", spec!.slice(2))) : normalize(join(dirname(file), spec!)));
}

function violations(files: readonly string[], forbidden: readonly string[]) {
  return files.flatMap((file) => importsOf(file)
    .filter((target) => forbidden.some((dir) => target === dir || target.startsWith(`${dir}/`)))
    .map((target) => `${file} → ${target}`));
}

const PAGE = "src/modules/page";
const BACKGROUND = "src/modules/background";

test("the page side never imports background modules", () => {
  const pageSide = [...sourcesIn(PAGE), ...sourcesIn("src/components"), ...sourcesIn("src/lib"), "src/entrypoints/content.ts"];
  assert.deepEqual(violations(pageSide, [BACKGROUND]), []);
});

test("shared modules import neither side", () => {
  assert.deepEqual(violations(sourcesIn("src/modules/shared"), [PAGE, BACKGROUND]), []);
});

test("background modules never import page modules", () => {
  assert.deepEqual(violations(sourcesIn(BACKGROUND), [PAGE]), []);
});

test("the check sees imports at all", () => {
  // Guards against a regex that silently matches nothing.
  assert.ok(importsOf(`${PAGE}/batch-scheduler/index.ts`).includes("src/modules/shared/protocol"));
});
