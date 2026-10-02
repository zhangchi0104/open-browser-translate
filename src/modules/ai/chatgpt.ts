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

/** Collapses a Responses API event stream into the equivalent non-streaming response body. */
export function collectResponseStream(text: string): Response {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: { type?: string; response?: { error?: { code?: string } } };
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (event.type === "response.completed" || event.type === "response.incomplete") return Response.json(event.response);
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
    HttpClient.transform((effect, request) => collect.has(request)
      ? Effect.flatMap(effect, (response) => Effect.map(response.text, (text) => HttpClientResponse.fromWeb(request, collectResponseStream(text))))
      : effect),
  );
}

export function chatgptLayer(options: { model: string; credentials: ChatGPTCredentials }) {
  return OpenAiLanguageModel.layer({ model: options.model, config: { store: false } }).pipe(
    Layer.provide(OpenAiClient.layer({ apiUrl: CHATGPT_API_URL, transformClient: planClient(options.credentials) })),
    Layer.provide(FetchHttpClient.layer),
  );
}
