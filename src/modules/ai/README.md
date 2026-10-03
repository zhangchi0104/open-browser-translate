# AI providers

`openAIDecisionLayer` provides Effect's `DecisionModel` (exported here as `AI`)
for typed decisions. `vercelLayer` provides `LanguageModel` for text generation through
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
`ContentAnalyzer`. The button uses this layer in the background after content analysis.
Keep model requests in the extension background context when wiring the UI.

The mocked HTTP tests check Chat Completions routing, authentication, model
selection, text decoding, and failure propagation. They do not call the live
gateway or verify a particular model's capabilities.

Reference: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

## Independent task configuration

Settings store provider connections separately from task selections:
`providers[provider].apiKey`, `analysis.{provider,models}`, and
`translation.{provider,models}`. Model IDs are retained per task and provider.
Analysis supports OpenAI with an API key or the ChatGPT sign-in; translation
supports Vercel, OpenAI with an API key, or the ChatGPT sign-in.

`models.ts` turns the settings into models. `AnalysisModel` (a `DecisionModel`)
and `TranslationModel` (a `LanguageModel`) are layers that read the `Settings`
and `ChatGPTToken` services when they're provided, so a settings change applies
to the next request. They fail with `ModelNotConfigured` when the purpose's
provider isn't connected or has no model, before any request is sent. Built
model layers are kept in `LayerMap`s (`ModelsLive`) keyed by everything that
picks the model, so requests on the same settings share one HTTP client.

The background provides `SettingsLive`, `ChatGPTTokenLive` and `ModelsLive` once,
in its `ManagedRuntime`. Tests use `modelsFor(settings, token?)`.

Settings v3 dropped Jev (TypeSafe). The migration keeps Vercel and OpenAI keys
and translation settings, discards TypeSafe keys and Jev model IDs, and points
analysis at OpenAI: the ChatGPT sign-in when translation already used it,
otherwise the OpenAI API key with `gpt-6-luna`.

Settings v4 adds the Vercel AI Gateway for analysis and makes it the default,
with `typesafe-ai/jev`. Analysis left on an OpenAI API key that was never
filled in moves to the gateway; configured OpenAI and ChatGPT choices stay.

## Content analysis on OpenAI

OpenAI announced a Decisions API (DevDay, 2026-09-29), but it is in limited
preview with no published endpoint or request format, so `openai-decisions.ts`
does not call it. Instead `languageModelDecisionLayer` answers any
`DecisionModel` definition with one structured-output request on the current
`LanguageModel`: the model returns a probability for every option of every
decision, which are normalized to sum to 1. Classify labels are the most likely
option, and `confidence` is that option's probability. Model-reported
probabilities are less calibrated than Jev's, so the 0.8 thresholds may need
tuning against live pages.

`openAIDecisionLayer` runs it on OpenAI's Chat Completions API with an API key;
`chatgptDecisionLayer` runs it on the ChatGPT plan through `chatgpt.ts`. When the
Decisions API is documented, replace the request in `openai-decisions.ts`; the
rest of the extension depends only on `DecisionModel`.

## Content analysis on the Vercel AI Gateway

The default until the Decisions API opens. The gateway lists models of type
`evaluation` (`typesafe-ai/jev`, `convaiinnovations/laya`, `liquid/d1`) that take
typed questions and return probabilities without generating text.
`vercelDecisionLayer` (`gateway-decisions.ts`) sends `DecisionModel` decisions to
them through the TypeSafe-compatible System One API at
`https://ai-gateway.vercel.sh/typesafe/v1`, so no structured-output simulation
is involved. It mirrors `@effect/ai-typesafe`'s adapter but renormalizes each
distribution: Jev rounds its probabilities, so they can sum to 0.9998, while
`DecisionModel` accepts only 1e-6 off. Sums within 0.05 of 1 are rescaled
(omitted labels count as 0); anything further off still fails. The options page offers the evaluation models hard-coded in
`GATEWAY_DECISION_MODELS` (`providers.ts`) for gateway analysis, and loads the
gateway's language models for gateway translation (`gateway-models.ts`).

## ChatGPT subscription (Sign in with ChatGPT)

Translation can run on the user's ChatGPT plan instead of an API key, using
OpenAI's official flow for open-source, locally hosted apps:
https://developers.openai.com/siwc/token-sharing-open-source

- `chatgpt-auth.ts` holds the protocol: dynamic client registration
  (`dynamic_agent_client` on first sign-in, then the issued `oaiapp_...` ID),
  PKCE, ID token verification against OpenAI's JWKS, refresh, and model listing.
- `chatgpt-session.ts` wires it into the extension. Sign-in opens a tab on
  OpenAI's authorize page. OpenAI only accepts loopback redirects, so the
  background reads the code from the tab when it navigates to
  `http://127.0.0.1:45173/callback` (nothing has to listen on that port) and
  closes the tab. Tokens are stored in `local:chatgptAuth`, separate from
  `aiSettings`.
- `chatgpt.ts` provides `LanguageModel` through `@effect/ai-openai`'s Responses
  adapter. Plan usage requires `stream: true` and `store: false`, so the HTTP
  client streams every request and returns the `response.completed` payload to
  the adapter. Reading the stream is its own `http.response.stream` span: the
  HTTP span ends when the headers arrive, while the model thinks and writes
  during the stream. The span records when the first event and the first
  output text arrived (`obt.stream.first_event_ms`, `obt.stream.first_output_ms`)
  and the token usage, including reasoning tokens.
- Analysis and translation on the plan can each turn on Fast mode
  (`fast` in their settings), sent as `service_tier: "fast"`, the tier Codex
  uses when signed in with ChatGPT. It uses plan limits at 2.5x the standard
  rate (https://learn.chatgpt.com/docs/agent-configuration/speed). The
  sign-in docs for open-source apps don't mention it, so a plan or model that
  doesn't allow it surfaces as a failed request in the trace.

Analysis can use the same sign-in (see above).
