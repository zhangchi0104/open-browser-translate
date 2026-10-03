import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Context, Effect, Layer, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CHATGPT_API_URL, ChatGPTAuthError } from "./chatgpt-auth";
import type { ReasoningEffort } from "../settings/model";

/** The ChatGPT sign-in, as models on the plan need it. The background's lives in `chatgpt-session.ts`. */
export class ChatGPTToken extends Context.Service<ChatGPTToken, {
  readonly signedIn: Effect.Effect<boolean>;
  /** A current OAuth access token, refreshed when needed. */
  readonly accessToken: Effect.Effect<string, ChatGPTAuthError>;
}>()("open-browser-translate/ChatGPTToken") {
  static readonly signedOut = Layer.succeed(ChatGPTToken, {
    signedIn: Effect.succeed(false),
    accessToken: Effect.fail(new ChatGPTAuthError("expired", "ChatGPT is signed out")),
  });
  /** Signed in with a token that never expires, for tests. */
  static readonly fixed = (token: string) => Layer.succeed(ChatGPTToken, {
    signedIn: Effect.succeed(true),
    accessToken: Effect.succeed(token),
  });
}

const USAGE_LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"]);

function jsonBody(request: HttpClientRequest.HttpClientRequest): Record<string, unknown> | undefined {
  if (request.body._tag !== "Uint8Array") return;
  try { return JSON.parse(request.body.text ?? new TextDecoder().decode(request.body.body)); } catch { return; }
}

interface Usage { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } }
interface StreamEvent {
  type?: string;
  response?: { output?: unknown[]; error?: { code?: string } };
  output_index?: number;
  item?: unknown;
  item_id?: string;
  delta?: string;
}

/**
 * Collapses a Responses API event stream into the equivalent non-streaming response body.
 * The ChatGPT plan endpoint can finish with an empty `output` and send the output only as
 * `response.output_item.done` events (or just text deltas), so those rebuild it.
 */
function parseResponseStream(text: string): { body: { usage?: Usage } & Record<string, unknown>; status: number; events: number } {
  const items: unknown[] = [];
  const deltas = new Map<string, string>();
  let events = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: StreamEvent;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    events++;
    if (event.type === "response.output_item.done" && event.item) items[event.output_index ?? items.length] = event.item;
    if (event.type === "response.output_text.delta" && event.delta) {
      const id = event.item_id ?? "msg";
      deltas.set(id, (deltas.get(id) ?? "") + event.delta);
    }
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      const response = event.response ?? {};
      if (response.output?.length) return { body: response, status: 200, events };
      const output = items.length ? items.filter(Boolean) : [...deltas].map(([id, text]) => ({
        type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }],
      }));
      return { body: { ...response, output }, status: 200, events };
    }
    if (event.type === "response.failed") {
      const error = event.response?.error;
      return { body: { error }, status: USAGE_LIMIT_CODES.has(error?.code ?? "") ? 429 : 502, events };
    }
  }
  return { body: { error: { message: "stream ended before response.completed" } }, status: 502, events };
}

/**
 * Reads a streamed response to the end as its own span. The HTTP span ends when the headers
 * arrive, so without this the model's thinking and writing would show as unexplained time;
 * the span notes when the first event and the first output text arrived, and the token usage.
 */
function readResponseStream(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    const start = Date.now();
    const decoder = new TextDecoder();
    let text = "";
    let firstEvent: number | undefined;
    let firstOutput: number | undefined;
    yield* Stream.runForEach(response.stream, (chunk) => Effect.sync(() => {
      const piece = decoder.decode(chunk, { stream: true });
      // Includes a little of the previous text in case an event name was split across chunks.
      const recent = text.slice(-64) + piece;
      text += piece;
      if (firstEvent === undefined && recent.includes("data:")) firstEvent = Date.now() - start;
      if (firstOutput === undefined && recent.includes('"response.output_text.delta"')) firstOutput = Date.now() - start;
    }));
    text += decoder.decode();
    const parsed = parseResponseStream(text);
    const usage = parsed.body.usage;
    yield* Effect.annotateCurrentSpan({
      "obt.stream.events": parsed.events,
      ...(firstEvent !== undefined && { "obt.stream.first_event_ms": firstEvent }),
      ...(firstOutput !== undefined && { "obt.stream.first_output_ms": firstOutput }),
      ...(usage?.input_tokens !== undefined && { "gen_ai.usage.input_tokens": usage.input_tokens }),
      ...(usage?.output_tokens !== undefined && { "gen_ai.usage.output_tokens": usage.output_tokens }),
      ...(usage?.output_tokens_details?.reasoning_tokens !== undefined && { "obt.usage.reasoning_tokens": usage.output_tokens_details.reasoning_tokens }),
    });
    return Response.json(parsed.body, { status: parsed.status });
  }).pipe(Effect.withSpan("http.response.stream"));
}

// ChatGPT plan usage requires `stream: true` and `store: false` on every Responses request,
// while Effect's generateText/generateObject send non-streaming requests. This client
// streams each request and hands the completed response back to the adapter unchanged.
function planClient(signIn: ChatGPTToken["Service"]) {
  const collect = new WeakSet<HttpClientRequest.HttpClientRequest>();
  return (client: HttpClient.HttpClient) => client.pipe(
    HttpClient.mapRequestEffect((request) => Effect.gen(function* () {
      const token = yield* Effect.orDie(signIn.accessToken);
      const next = HttpClientRequest.bearerToken(request, token);
      const body = request.method === "POST" && request.url.endsWith("/responses") ? jsonBody(request) : undefined;
      if (!body) return next;
      const streamed = HttpClientRequest.bodyJsonUnsafe(next, { ...body, stream: true, store: false });
      if (!body.stream) collect.add(streamed);
      return streamed;
    })),
    // The client's own status check ran before this transform, so a stream that ended in
    // `response.failed` is checked here; otherwise its error would reach the adapter as a body.
    HttpClient.transform((effect, request) => collect.has(request)
      ? Effect.flatMap(effect, (response) => Effect.flatMap(readResponseStream(response), (collected) =>
        HttpClientResponse.filterStatusOk(HttpClientResponse.fromWeb(request, collected))))
      : effect),
  );
}

/** `LanguageModel` on the signed-in ChatGPT plan. */
export function chatgptLayer(options: { model: string; reasoningEffort?: ReasoningEffort; fast?: boolean }) {
  const reasoning = options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : undefined;
  // Fast mode, as Codex requests it on a ChatGPT plan; it uses plan limits at 2.5x the standard rate.
  const tier = options.fast ? { service_tier: "fast" as const } : undefined;
  return Layer.unwrap(Effect.map(ChatGPTToken, (signIn) =>
    OpenAiLanguageModel.layer({ model: options.model, config: { store: false, ...reasoning, ...tier } }).pipe(
      Layer.provide(OpenAiClient.layer({ apiUrl: CHATGPT_API_URL, transformClient: planClient(signIn) })),
      Layer.provide(FetchHttpClient.layer),
    )));
}
