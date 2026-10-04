import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { vercelLayer } from "../src/modules/background/ai/vercel";
import { listGatewayModels } from "../src/modules/background/ai/gateway-models";

test("Vercel layer uses Chat Completions with the selected model", async () => {
  let calls = 0;
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://ai-gateway.vercel.sh/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-placeholder");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-provider/test-model");
    assert.ok(JSON.stringify(body.messages).includes("Translate Hello into Chinese"));
    return Response.json({
      id: "test-completion",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  };
  const response = await Effect.runPromise(
    LanguageModel.generateText({ prompt: "Translate Hello into Chinese" }).pipe(
      Effect.provide(vercelLayer({ apiKey: Redacted.make("test-placeholder"), model: "test-provider/test-model" })),
      Effect.provideService(FetchHttpClient.Fetch, fetchMock),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(response.text, "你好");
});

test("Vercel authentication failures remain typed Effect failures", async () => {
  const fetchMock: typeof globalThis.fetch = async () => Response.json({
    error: { message: "Invalid API key", type: "authentication_error" },
  }, { status: 401 });
  const exit = await Effect.runPromiseExit(
    LanguageModel.generateText({ prompt: "Hello" }).pipe(
      Effect.provide(vercelLayer({ apiKey: Redacted.make("test-placeholder"), model: "test-provider/test-model" })),
      Effect.provideService(FetchHttpClient.Fetch, fetchMock),
    ),
  );
  assert.equal(exit._tag, "Failure");
});

test("the gateway catalog keeps language models, newest first, without a key", async () => {
  const requests: Request[] = [];
  const catalog = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ object: "list", data: [
      { id: "vendor/old", name: "Old", type: "language", released: 1 },
      { id: "vendor/embed", name: "Embed", type: "embedding", released: 9 },
      { id: "openai/gpt-6-luna", name: "GPT-6 Luna", type: "language", released: 5 },
      { id: "typesafe-ai/jev", name: "Jev", type: "evaluation", released: 3 },
    ] });
  };
  assert.deepEqual(await listGatewayModels(catalog), [{ slug: "openai/gpt-6-luna", displayName: "GPT-6 Luna" }, { slug: "vendor/old", displayName: "Old" }]);
  assert.equal(requests[0]!.url, "https://ai-gateway.vercel.sh/v1/models");
  assert.equal(requests[0]!.headers.get("Authorization"), null);
});
