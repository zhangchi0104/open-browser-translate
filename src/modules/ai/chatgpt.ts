import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { CHATGPT_API_URL } from "./chatgpt-auth";

export interface ChatGPTCredentials {
  /** Resolves a current OAuth access token, refreshing it when needed. */
  readonly accessToken: () => Promise<string>;
}

const USAGE_LIMIT_CODES = new Set(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"]);

function jsonBody(request: HttpClientRequest.HttpClientRequest): Record<string, unknown> | undefined {
  if (request.body._tag !== "Uint8Array") return;
  try { return JSON.parse(request.body.text ?? new TextDecoder().decode(request.body.body)); } catch { return; }
}

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
export function collectResponseStream(text: string): Response {
  const items: unknown[] = [];
  const deltas = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: StreamEvent;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (event.type === "response.output_item.done" && event.item) items[event.output_index ?? items.length] = event.item;
    if (event.type === "response.output_text.delta" && event.delta) {
      const id = event.item_id ?? "msg";
      deltas.set(id, (deltas.get(id) ?? "") + event.delta);
    }
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      const response = event.response ?? {};
      if (response.output?.length) return Response.json(response);
      const output = items.length ? items.filter(Boolean) : [...deltas].map(([id, text]) => ({
        type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }],
      }));
      return Response.json({ ...response, output });
    }
    if (event.type === "response.failed") {
      const error = event.response?.error;
      return Response.json({ error }, { status: USAGE_LIMIT_CODES.has(error?.code ?? "") ? 429 : 502 });
    }
  }
  return Response.json({ error: { message: "stream ended before response.completed" } }, { status: 502 });
}

// ChatGPT plan usage requires `stream: true` and `store: false` on every Responses request,
// while Effect's generateText/generateObject send non-streaming requests. This client
// streams each request and hands the completed response back to the adapter unchanged.
function planClient(credentials: ChatGPTCredentials) {
  const collect = new WeakSet<HttpClientRequest.HttpClientRequest>();
  return (client: HttpClient.HttpClient) => client.pipe(
    HttpClient.mapRequestEffect((request) => Effect.gen(function* () {
      const token = yield* Effect.orDie(Effect.tryPromise(credentials.accessToken));
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
      ? Effect.flatMap(effect, (response) => Effect.flatMap(response.text, (text) =>
        HttpClientResponse.filterStatusOk(HttpClientResponse.fromWeb(request, collectResponseStream(text)))))
      : effect),
  );
}

export function chatgptLayer(options: { model: string; credentials: ChatGPTCredentials }) {
  return OpenAiLanguageModel.layer({ model: options.model, config: { store: false } }).pipe(
    Layer.provide(OpenAiClient.layer({ apiUrl: CHATGPT_API_URL, transformClient: planClient(options.credentials) })),
    Layer.provide(FetchHttpClient.layer),
  );
}
