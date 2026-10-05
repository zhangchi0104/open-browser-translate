import type { ChatGPTModel } from "../../shared/protocol";

export const OPENAI_API_URL = "https://api.openai.com/v1";
// The catalog also lists models that can't generate text; these never fit analysis or translation.
const NOT_TEXT = /embedding|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|sora|davinci|babbage/;

/**
 * Models an OpenAI API key can use for text, newest first; `apiUrl` lists another OpenAI-compatible
 * API's models, with no key when it takes none. https://platform.openai.com/docs/api-reference/models/list
 */
export async function listOpenAIModels(apiKey: string, fetcher: typeof fetch = fetch, apiUrl = OPENAI_API_URL): Promise<ChatGPTModel[]> {
  const response = await fetcher(`${apiUrl.replace(/\/+$/, "")}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!response.ok) throw new Error(`models request failed with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  const body = await response.json() as { data?: { id?: string; created?: number }[] };
  return (body.data ?? [])
    .filter((model): model is { id: string; created?: number } => !!model.id && !NOT_TEXT.test(model.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map(({ id }) => ({ slug: id, displayName: id }));
}
