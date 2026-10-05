import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pageBrief } from "../src/modules/page/block-collector";
import { SURROUNDINGS_LIMITS } from "../src/modules/shared/protocol";

test("the page brief is the title, description and first heading, without repeats or blanks", () => {
  assert.equal(pageBrief({ title: "Fibers | Effect Docs", description: "  Lightweight\n threads ", heading: "Fibers" }), "Fibers | Effect Docs\nLightweight threads");
  assert.equal(pageBrief({ title: "", description: null, heading: "  " }), undefined);
  assert.equal(pageBrief({ title: "x".repeat(2000) })!.length, SURROUNDINGS_LIMITS.brief);
});
