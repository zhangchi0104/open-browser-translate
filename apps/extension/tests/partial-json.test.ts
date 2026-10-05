import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePartialJson, partialTranslations } from "../src/modules/background/translation-service/partial-json";

test("complete JSON parses as usual", () => {
  const value = { translations: [{ id: 0, text: "你好" }], terms: [{ source: "A", target: "甲" }], n: -1.5e2, ok: true, none: null };
  assert.deepEqual(parsePartialJson(JSON.stringify(value)), value);
});

test("truncated JSON keeps what has arrived, including a string still being written", () => {
  assert.deepEqual(parsePartialJson('{"translations":[{"id":0,"text":"你好"},{"id":1,"text":"世'), {
    translations: [{ id: 0, text: "你好" }, { id: 1, text: "世" }],
  });
  assert.deepEqual(parsePartialJson('{"translations":[{"id":0,"te'), { translations: [{ id: 0 }] });
  assert.deepEqual(parsePartialJson('{"translations":[{"id":1'), { translations: [{ id: 1 }] }, "a number at the end may still grow, but its digits so far count");
  assert.deepEqual(parsePartialJson('{"a":tr'), {}, "an unfinished literal is left out");
  assert.equal(parsePartialJson(""), undefined);
});

test("escapes decode, and an escape cut off at the end is dropped", () => {
  assert.deepEqual(parsePartialJson('{"t":"a\\"b\\n\\u4f60\\\\'), { t: 'a"b\n你\\' });
  assert.deepEqual(parsePartialJson('{"t":"ab\\u4f'), { t: "ab" });
  assert.deepEqual(parsePartialJson('{"t":"ab\\'), { t: "ab" });
});

test("model chatter around the JSON is ignored", () => {
  assert.deepEqual(parsePartialJson('```json\n{"translations":[{"id":0,"text":"好"}]}\n```'), { translations: [{ id: 0, text: "好" }] });
});

test("partial translations are the entries with an id and some text", () => {
  assert.deepEqual(partialTranslations('{"translations":[{"id":0,"text":"你好"},{"id":1,"text":""},{"id":2,"te'), [{ id: 0, text: "你好" }]);
  assert.deepEqual(partialTranslations("not json"), []);
});
