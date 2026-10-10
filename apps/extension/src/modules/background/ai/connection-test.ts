import type { ConnectionTestResult } from "../../shared/protocol";

/** How long a test waits for the model list before giving up. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

/** The first 300 characters of a server's error: its `error.message` when it sends one, else the body unless it's a web page. */
function serverMessage(text: string): string | undefined {
  if (/^\s*</.test(text)) return;
  let message = text;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    // OpenAI sends { error: { message } }; other servers send the message bare or under another key.
    const candidates = [body?.error, (body?.error as { message?: unknown })?.message, body?.message, body?.detail];
    message = candidates.find((candidate): candidate is string => typeof candidate === "string") ?? text;
  } catch {}
  const clipped = message.replace(/\s+/g, " ").trim().slice(0, 300);
  return clipped || undefined;
}

function failureOf(status: number): "unauthorized" | "not-found" | "http" {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return "http";
}

/**
 * Lists the models at an OpenAI-compatible `apiUrl` with `apiKey` (none when empty) once, to tell
 * whether the connection works and, when it doesn't, why. `models` are model IDs the connection is
 * used with; those the list doesn't name come back as `missing`.
 */
export async function testConnection(
  { apiUrl, apiKey, models = [] }: { apiUrl: string; apiKey: string; models?: readonly string[] },
  { fetcher = fetch, timeoutMs = CONNECTION_TEST_TIMEOUT_MS }: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<ConnectionTestResult> {
  let url: URL;
  try {
    url = new URL(`${apiUrl.trim().replace(/\/+$/, "")}/models`);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(url.protocol);
  } catch {
    return { status: "error", reason: "invalid-url" };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url.href, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) return { status: "error", reason: "timeout", url: url.href };
    return { status: "error", reason: "network", url: url.href, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  if (!response.ok) {
    const detail = serverMessage(text);
    return { status: "error", reason: failureOf(response.status), url: url.href, httpStatus: response.status, ...(detail && { detail }) };
  }
  let ids: string[] | undefined;
  try {
    const body = JSON.parse(text) as { data?: unknown };
    if (Array.isArray(body?.data)) ids = body.data.flatMap((model) => typeof model?.id === "string" ? [model.id] : []);
  } catch {}
  if (!ids) {
    // A web page rather than an API: usually the site's address without the API's path.
    if (/^\s*</.test(text) || /html/i.test(response.headers.get("content-type") ?? "")) return { status: "error", reason: "html", url: url.href };
    const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
    return { status: "error", reason: "bad-response", url: url.href, ...(detail && { detail }) };
  }
  const listed = new Set(ids);
  const missing = [...new Set(models.map((model) => model.trim()).filter((model) => model && !listed.has(model)))];
  return { status: "ok", models: ids.length, ms, missing };
}
