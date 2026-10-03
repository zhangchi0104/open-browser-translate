import type { ChatGPTModel } from "../protocol";

export const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1";

/** The gateway's language models, newest first. The catalog is public, so no key is needed. */
export async function listGatewayModels(fetcher: typeof fetch = fetch): Promise<ChatGPTModel[]> {
  const response = await fetcher(`${GATEWAY_API_URL}/models`);
  if (!response.ok) throw new Error(`models request failed with ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  const body = await response.json() as { data?: { id?: string; name?: string; type?: string; released?: number; created?: number }[] };
  return (body.data ?? [])
    .filter((model): model is typeof model & { id: string } => !!model.id && model.type === "language")
    .sort((a, b) => (b.released ?? b.created ?? 0) - (a.released ?? a.created ?? 0) || a.id.localeCompare(b.id))
    .map(({ id, name }) => ({ slug: id, displayName: name ?? id }));
}
