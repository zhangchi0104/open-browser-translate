import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { ChatGPTModel } from "../../shared/protocol";
import type { ReasoningEffort } from "../../shared/settings/model";
import { ANTHROPIC_API_URL, ANTHROPIC_BROWSER_ACCESS, anthropicHeaders } from "./endpoints";

// Claude's effort has no off or minimal level; the lowest it takes is `low`.
const EFFORTS: Record<ReasoningEffort, "low" | "medium" | "high" | "xhigh"> = {
  none: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh",
};

/**
 * `LanguageModel` on Claude through the Messages API, with Effect's Anthropic adapter. Structured
 * output goes as `output_config.format`, and a reasoning effort, when set, as `output_config.effort`
 * (models that take no effort reject it). Thinking is left to the model's default.
 */
export function anthropicLayer(options: { apiKey: Redacted.Redacted<string>; model: string; reasoningEffort?: ReasoningEffort }) {
  // The adapter's types predate `xhigh`; the API takes it on the models that offer it.
  const effort = options.reasoningEffort && EFFORTS[options.reasoningEffort] as "low" | "medium" | "high";
  return AnthropicLanguageModel.layer({ model: options.model, ...(effort && { config: { output_config: { effort } } }) }).pipe(
    Layer.provide(AnthropicClient.layer({
      apiKey: options.apiKey,
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(ANTHROPIC_BROWSER_ACCESS)),
    })),
    Layer.provide(FetchHttpClient.layer),
  );
}

/** Claude models an Anthropic API key can use, newest first (`GET /v1/models`). */
export async function listAnthropicModels(apiKey: string, fetcher: typeof fetch = fetch): Promise<ChatGPTModel[]> {
  const response = await fetcher(`${ANTHROPIC_API_URL}/v1/models?limit=1000`, { headers: anthropicHeaders(apiKey) });
  if (!response.ok) throw new Error(`models request failed with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  const body = await response.json() as { data?: { id?: string; display_name?: string; created_at?: string }[] };
  return (body.data ?? [])
    .filter((model): model is typeof model & { id: string } => !!model.id)
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || a.id.localeCompare(b.id))
    .map(({ id, display_name }) => ({ slug: id, displayName: display_name || id }));
}
