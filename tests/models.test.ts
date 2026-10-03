import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChatGPTToken } from "../src/modules/ai/chatgpt";
import { ModelsLive } from "../src/modules/ai/models";
import { AiProviders } from "../src/modules/ai/providers";
import { defaultSettings, type AISettings } from "../src/modules/settings/model";
import { Settings } from "../src/modules/settings/service";
import { translateBatch } from "../src/modules/translator/translate-batch";

test("one runtime translates on whatever model the settings select when each request starts", async () => {
  let current: AISettings = structuredClone(defaultSettings);
  current.providers.VercelAIGateway.apiKey = "test-gateway";
  current.translation.models.VercelAIGateway = "vendor/first";
  const runtime = ManagedRuntime.make(ModelsLive.pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(Settings, { get: Effect.sync(() => current) }),
    ChatGPTToken.signedOut,
  ))));
  const models: string[] = [];
  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    const content = JSON.stringify({ translations: [{ id: 0, text: "你好" }], terms: [] });
    return Response.json({ id: "test", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
  };
  const translate = () => runtime.runPromise(translateBatch([{ text: "Hello", tag: "p" }], "all", { analyzed: true })
    .pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock)));

  assert.equal((await translate()).status, "ok");
  current = structuredClone(current);
  current.translation.models.VercelAIGateway = "vendor/second";
  assert.equal((await translate()).status, "ok");
  assert.deepEqual(models, ["vendor/first", "vendor/second"]);

  // Switching to the ChatGPT plan while signed out sends nothing.
  current = structuredClone(current);
  current.translation.provider = AiProviders.OpenAISubscription;
  current.translation.models.OpenAISubscription = "gpt-test";
  assert.deepEqual(await translate(), { status: "not-configured", purpose: "translation" });
  assert.equal(models.length, 2);
  await runtime.dispose();
});
