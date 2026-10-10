import { strict as assert } from "node:assert";
import { test } from "node:test";
import { filterModels, sortModels } from "../src/components/model-search";

const model = (slug: string, displayName = slug) => ({ slug, displayName });

test("models sort A–Z by name, ignoring case, with numbers in numeric order", () => {
  const models = [model("openai/gpt-10", "GPT-10"), model("anthropic/claude", "claude"), model("openai/gpt-5", "GPT-5"), model("z/alpha", "Alpha")];
  assert.deepEqual(sortModels(models).map(({ displayName }) => displayName), ["Alpha", "claude", "GPT-5", "GPT-10"]);
});

test("models with the same name sort by ID, and sorting leaves the catalog as it was", () => {
  const models = [model("b/same", "Same"), model("a/same", "Same")];
  assert.deepEqual(sortModels(models).map(({ slug }) => slug), ["a/same", "b/same"]);
  assert.equal(models[0]!.slug, "b/same");
});

test("a search matches every word against the name or the ID, ignoring case", () => {
  const models = [model("openai/gpt-5-mini", "GPT-5 mini"), model("openai/gpt-5", "GPT-5"), model("google/gemini-pro", "Gemini Pro")];
  assert.deepEqual(filterModels(models, "5 MINI").map(({ slug }) => slug), ["openai/gpt-5-mini"]);
  assert.deepEqual(filterModels(models, "openai 5").map(({ slug }) => slug), ["openai/gpt-5-mini", "openai/gpt-5"]);
  assert.deepEqual(filterModels(models, "google/"), [models[2]]);
  assert.equal(filterModels(models, "  ").length, 3);
  assert.deepEqual(filterModels(models, "claude"), []);
});
