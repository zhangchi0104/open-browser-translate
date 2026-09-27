# AI providers

`jevLayer` provides Effect's `DecisionModel` (exported here as `AI`) for typed
decisions. `vercelLayer` provides `LanguageModel` for text generation through
Vercel AI Gateway's OpenAI-compatible Chat Completions endpoint.

```ts
import { Effect, type Redacted } from "effect";
import { LanguageModel, vercelLayer } from "@/modules/ai";

export function translate(
  text: string,
  apiKey: Redacted.Redacted<string>,
  model: string,
) {
  return LanguageModel.generateText({
    prompt: `Translate the following text into Chinese:\n${text}`,
  }).pipe(
    Effect.map((response) => response.text),
    Effect.provide(vercelLayer({ apiKey, model })),
  );
}
```

Run the returned Effect with `Effect.runPromise` at the application boundary.
Supply a Vercel AI Gateway key at runtime and a gateway model ID in
`provider/model` format. The layer uses `https://ai-gateway.vercel.sh/v1` and
the official `@effect/ai-openai-compat` adapter, pinned to the installed Effect
version. It adds no retry or timeout policy; callers can compose those policies.

This is a language-model layer, not a `DecisionModel` replacement for
`ContentAnalyzer`. The button uses this layer in the background after Jev filtering.
Keep model requests in the extension background context when wiring the UI.

The mocked HTTP tests check Chat Completions routing, authentication, model
selection, text decoding, and failure propagation. They do not call the live
gateway or verify a particular model's capabilities.

Reference: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

## Independent task configuration

Settings v2 stores provider connections separately from task selections:
`providers[provider].apiKey`, `analysis.{provider,models}`, and
`translation.{provider,models}`. Model IDs are retained per task and provider.
Analysis supports TypeSafe directly or Vercel; translation supports Vercel or
OpenAI directly. TypeSafe is not offered as a translation provider.

`jevLayer({ provider: "VercelAIGateway", apiKey })` uses
`https://ai-gateway.vercel.sh/typesafe/v1/systemone` with the default model
`typesafe-ai/jev`. Direct TypeSafe keeps the default `jev-latest`.

`analysisLayerFromSettings` and `translationLayerFromSettings` in `configured.ts`
resolve the independent model and shared provider key into the appropriate
Effect layer. Callers should ensure the selected key and model are configured
before invoking a model. The button runs both helpers in the background, with independent provider settings.

The storage migration preserves existing provider keys and model IDs. Legacy
Vercel model IDs beginning with `typesafe-ai/` migrate to analysis; other Vercel
model IDs migrate to translation. Direct TypeSafe model IDs migrate to analysis.

Vercel TypeSafe API reference: https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
