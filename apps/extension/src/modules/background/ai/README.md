# AI providers

`openAIDecisionLayer` provides Effect's `DecisionModel` (exported here as `AI`)
for typed decisions on OpenAI's Decisions API. `vercelLayer` provides `LanguageModel` for text generation through
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

Settings keep a list of named connections separately from task selections:
`connections[]` (`{ id, kind, name, apiKey, apiUrl? }`), `analysis.{connection,models}`
and `translation.{connection,models}`. A connection's kind is the Vercel AI
Gateway, OpenRouter, OpenAI, Anthropic, or `Custom`: any OpenAI-compatible API
at `apiUrl`, where the key may be empty for local servers. There can be several of each kind. The
ChatGPT sign-in stays one per browser, reached through the fixed connection id
`CHATGPT_CONNECTION`. Model IDs are retained per task and connection.

Either task can use any connection. Analysis on the gateway asks its evaluation
models (Jev and similar), and on an OpenAI key the Decisions API; on the ChatGPT
plan or a custom connection it answers decisions with an ordinary model (see below). Custom connections share the OpenAI client with
their own base URL, and cached answers from them are also keyed by that URL.
The background reaches a custom server only with host permission for its
origin, which the settings page requests when it saves or tests the connection.

### Testing a connection

The options page's 「测试连接」 button sends `test-connection` with the URL and
key as entered, saved or not, and the models the connection is used with.
`testConnection` (`connection-test.ts`) lists the models once the way the
connection's API does (`api`: OpenAI-compatible `GET {apiUrl}/models` with a
bearer key, OpenRouter's `/models/user`, or Anthropic's `/v1/models` with
`x-api-key`), with
a 10-second timeout, and returns a typed result: `ok` with the number of models,
the time taken and the connection's models the list doesn't name; or `error`
with a reason (`invalid-url`, `network`, `timeout`, `unauthorized` for 401/403,
`not-found`, `html` when the address serves a web page, `bad-response`, or
`http` for any other status), the HTTP status, the server's message and the
response body (up to 4000 characters, saying how much was left out). The page
turns it into advice (`entrypoints/options/connection-test.ts`), such as adding
`/v1`, and shows everything that came back in full below it.

Every test is a request trace in 「调试日志」→「请求追踪」, recorded by the same
local tracer as translation. The background runs it as `traceConnectionTest`:
a `test-connection` root span (连接测试请求) with the address, whether there was
a key (never the key), the connection's models and the result
(`obt.test.result`, `obt.test.reason`, `obt.test.models_listed`,
`obt.test.missing`), and a `connection.list-models` client span (读取模型列表)
for the request, with `url.full`, `http.response.status_code`, `error.type` and
the server's message and response body as events. A failed test marks both
spans failed, so it shows under 仅出错的请求. Failures only the options page
sees (permission refused, the request not delivered, a reply it can't decode)
are sent as `connection-test-failed`, which the background records as a failed
`test-connection` trace (`obt.test.reason`: `page-permission`, `page-send`,
`page-reply`). If the background can't be reached, there is nothing to record
it, and the page console is the only place it appears. Both sides also print
each test to the console (`connectionTestLog`). A reply of nothing at all usually means
the service worker is older than the page: an unpacked extension's pages load
fresh from disk after a rebuild, but its worker keeps running the old script
until the extension is reloaded, and the old worker has no handler for the
newer request. Custom connections and OpenAI, Anthropic and OpenRouter keys can be tested; the Vercel AI
Gateway lists its models without a key, so listing them proves nothing.

`models.ts` turns the settings into models. `AnalysisModel` (a `DecisionModel`)
and `TranslationModel` (a `LanguageModel`) are layers that read the `Settings`
and `ChatGPTToken` services when they're provided, so a settings change applies
to the next request. They fail with `ModelNotConfigured` when the purpose's
connection isn't set up (no key; for a custom one, no address), was removed, or
has no model, before any request is sent. Built
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

Settings v5 turns the one key per provider into connections. Each v4 key
becomes a connection whose id is its provider's name (`VercelAIGateway`,
`OpenAIApi`), and the ChatGPT sign-in keeps `OpenAISubscription`, so purposes
and their remembered models carry over unchanged.

Settings v6 resets the analysis model remembered for every OpenAI connection to
`gpt-6-luna`, the only model the Decisions API runs.

## Anthropic and OpenRouter

Both take an API key. Neither has dedicated decision models, so analysis
on them answers decisions with an ordinary model (`languageModelDecisionLayer`,
see below). Their URLs and Anthropic's headers live in `endpoints.ts`, which
the options page imports without bundling a model client.

- `anthropic.ts`: Claude through the Messages API (`@effect/ai-anthropic`).
  Structured output goes as `output_config.format`, and a reasoning effort as
  `output_config.effort`. Claude has no `none` or `minimal` effort, so those
  map to `low`; models that take no effort reject one that is set. Thinking is
  left to the model's default. The background's requests carry the extension's
  origin, which the API refuses without
  `anthropic-dangerous-direct-browser-access: true`; the key is the user's
  own, so the header is always sent. `listAnthropicModels` reads `GET /v1/models`.
- `openrouter.ts`: OpenRouter's Chat Completions, through the same
  OpenAI-compatible client as custom connections: OpenRouter takes OpenAI's
  request shape, and an effort goes as `reasoning_effort`, its shorthand for
  `reasoning.effort`. Effect's OpenRouter adapter would add some 400 kB of
  generated schemas to the background for nothing this extension uses. Model IDs are `provider/model`, like
  the gateway's. `listOpenRouterModels` reads `GET /models/user`: the catalog
  filtered by the account's provider, privacy and guardrail settings. It takes
  the key, unlike the public `/models`, so the list and 「测试连接」 both check it.

Neither host is in the manifest's `host_permissions`, since adding hosts there
makes Chrome disable the extension on update until the user re-approves. The
options page asks for the origin at runtime instead (it is in
`optional_host_permissions`), when a connection of either kind with a key is
saved or tested, like a custom connection's server.

## Content analysis on OpenAI

`openAIDecisionLayer` (`openai-decisions.ts`) sends `DecisionModel` decisions to
OpenAI's Decisions API, `POST /v1/decisions`, in public beta since October 2026:
https://developers.openai.com/api/docs/guides/decisions. The request and
response shapes follow openai-node's `src/resources/decisions.ts`; there is no
Effect adapter yet. All of a request's decisions go as one `questions` array,
each named by its decision key, with the state as `input` (JSON text unless it is
already a string):

- `Classify` → a `choice` question; each label is a choice value, its criterion
  the description.
- `Rate` → a `score` question; the levels in order. Per-level probabilities come
  back by index and are mapped to the level names.
- `Probability` → a `predicate` question. Predicates have no options, so the true
  and false criteria are appended to the instructions.

Distributions are renormalized like Jev's (see below). A `refusal` answer fails
the request with `ContentPolicyError`; HTTP errors map to `AiError` reasons by
status (401 → `AuthenticationError`, 429 → `RateLimitError`, ...). The API takes
no reasoning effort or service tier, so those settings don't apply here, and
`gpt-6-luna` is the only model.

`decisionModels(purpose, provider)` in `shared/settings/model.ts` owns the fixed
decision models: the gateway's evaluation models and the Decisions API's. It
supplies the default model, the lists the options page and the quick panel
offer, the check that rejects any other model when settings are saved, and
whether the purpose's reasoning effort applies (`modelConfig` drops it for
decision models).

The endpoint takes an API key, so the ChatGPT plan can't use it, and
OpenAI-compatible servers don't have it. There `languageModelDecisionLayer`
(`structured-decisions.ts`) answers any `DecisionModel` definition with one
structured-output request on the current `LanguageModel`: the model returns a
probability for every option of every decision, which are normalized to sum to 1.
Classify labels are the most likely option, and `confidence` is that option's
probability. Model-reported probabilities are less calibrated than a decision
model's, so the 0.8 thresholds may need tuning against live pages.
`chatgptDecisionLayer` runs it on the ChatGPT plan through `chatgpt.ts`, and
`compatibleDecisionLayer` on a custom connection.

## Content analysis on the Vercel AI Gateway

The default analysis connection. The gateway lists models of type
`evaluation` (`typesafe-ai/jev`, `convaiinnovations/laya`, `liquid/d1`) that take
typed questions and return probabilities without generating text.
`vercelDecisionLayer` (`gateway-decisions.ts`) sends `DecisionModel` decisions to
them through the TypeSafe-compatible System One API at
`https://ai-gateway.vercel.sh/typesafe/v1`, so no structured-output simulation
is involved. It mirrors `@effect/ai-typesafe`'s adapter but renormalizes each
distribution: Jev rounds its probabilities, so they can sum to 0.9998, while
`DecisionModel` accepts only 1e-6 off. Sums within 0.05 of 1 are rescaled
(omitted labels count as 0); anything further off still fails
(`distribution.ts`, shared with the Decisions API). Gateway analysis offers the
evaluation models from `decisionModels`; gateway translation loads the gateway's
language models (`gateway-models.ts`).

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
  (`fast` in their settings), sent as `service_tier: "priority"`, the tier
  Codex uses when signed in with ChatGPT (Codex's config calls it `fast`,
  but the API rejects that value). It uses plan limits at 2.5x the standard
  rate (https://learn.chatgpt.com/docs/agent-configuration/speed). The
  sign-in docs for open-source apps don't mention it, so a plan or model that
  doesn't allow it surfaces as a failed request in the trace.

Analysis can use the same sign-in (see above).
