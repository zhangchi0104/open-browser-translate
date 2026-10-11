import type { Redacted } from "effect";
import type { ChatGPTModel } from "../../shared/protocol";
import type { ReasoningEffort } from "../../shared/settings/model";
import { OPENROUTER_API_URL } from "./endpoints";
import { openAICompatibleLayer } from "./vercel";

/**
 * `LanguageModel` on OpenRouter's Chat Completions API. It takes OpenAI's request shape, including
 * `response_format`, `stream_options` and `reasoning_effort` (its shorthand for `reasoning.effort`,
 * mapped onto each provider's own setting), so the OpenAI-compatible client serves it; Effect's
 * OpenRouter adapter would add its generated schemas, some 400 kB, to the background.
 */
export function openRouterLayer(options: { apiKey: Redacted.Redacted<string>; model: string; reasoningEffort?: ReasoningEffort }) {
  return openAICompatibleLayer({ ...options, apiUrl: OPENROUTER_API_URL });
}

/**
 * The models an OpenRouter key can use, newest first: `GET /models/user`, the catalog filtered by
 * the account's provider, privacy and guardrail settings, keeping models that write text. It takes
 * the key, so listing also checks it (the unfiltered `/models` is public).
 */
export async function listOpenRouterModels(apiKey: string, fetcher: typeof fetch = fetch): Promise<ChatGPTModel[]> {
  const response = await fetcher(`${OPENROUTER_API_URL}/models/user`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`models request failed with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  const body = await response.json() as { data?: { id?: string; name?: string; created?: number; architecture?: { output_modalities?: string[] } }[] };
  return (body.data ?? [])
    .filter((model): model is typeof model & { id: string } => !!model.id && (model.architecture?.output_modalities ?? ["text"]).includes("text"))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map(({ id, name }) => ({ slug: id, displayName: name || id }));
}
