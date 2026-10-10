import type { ConnectionTestResult } from "../../shared/protocol";

/** How long a test waits for the model list before giving up. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

/** The most of a response body a result carries. */
const MAX_BODY = 4000;

/** `text` up to `max` characters, saying how much was left out. */
function bounded(text: string, max = MAX_BODY): string {
  return text.length > max ? `${text.slice(0, max)}\n（共 ${text.length} 个字符，只保留前 ${max} 个）` : text;
}

/** The error message in a server's JSON error body, if it has one. */
function serverMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    // OpenAI sends { error: { message } }; other servers send the message bare or under another key.
    const candidates = [body?.error, (body?.error as { message?: unknown })?.message, body?.message, body?.detail];
    const message = candidates.find((candidate): candidate is string => typeof candidate === "string")?.trim();
    return message ? bounded(message) : undefined;
  } catch {}
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
  const body = text.trim() ? { body: bounded(text) } : {};
  if (!response.ok) {
    const detail = serverMessage(text);
    return { status: "error", reason: failureOf(response.status), url: url.href, httpStatus: response.status, ...(detail && { detail }), ...body };
  }
  let ids: string[] | undefined;
  try {
    const body = JSON.parse(text) as { data?: unknown };
    if (Array.isArray(body?.data)) ids = body.data.flatMap((model) => typeof model?.id === "string" ? [model.id] : []);
  } catch {}
  if (!ids) {
    // A web page rather than an API: usually the site's address without the API's path.
    const html = /^\s*</.test(text) || /html/i.test(response.headers.get("content-type") ?? "");
    return { status: "error", reason: html ? "html" : "bad-response", url: url.href, httpStatus: response.status, ...body };
  }
  const listed = new Set(ids);
  const missing = [...new Set(models.map((model) => model.trim()).filter((model) => model && !listed.has(model)))];
  return { status: "ok", models: ids.length, ms, missing };
}

/** Everything a failed test got back, line by line: the request, HTTP status, server message and body. */
export function failureDetails(result: Extract<ConnectionTestResult, { status: "error" }>): string {
  return [
    result.url && `请求：GET ${result.url}`,
    result.httpStatus !== undefined && `HTTP 状态：${result.httpStatus}`,
    result.detail && `说明：${result.detail}`,
    result.body && `响应内容：\n${result.body}`,
  ].filter(Boolean).join("\n");
}

/**
 * A debug log entry for a test: what was asked (never the key, only whether there was one) and
 * everything that came back, so a failure the options page showed can be found again in the log.
 */
export function connectionTestLog(
  { apiUrl, apiKey, models = [] }: { apiUrl: string; apiKey: string; models?: readonly string[] },
  result: ConnectionTestResult,
): { level: "info" | "warn"; event: string; detail: string } {
  const asked = [`接口地址：${apiUrl}`, `API key：${apiKey ? "已填写" : "未填写"}`, models.length ? `使用的模型：${models.join("、")}` : ""];
  const detail = (...found: string[]) => [...asked, ...found].filter(Boolean).join("\n");
  if (result.status === "error") return { level: "warn", event: `测试连接失败：${result.reason}`, detail: detail(`原因：${result.reason}`, failureDetails(result)) };
  const listed = `列出 ${result.models} 个模型，用时 ${result.ms} 毫秒`;
  if (!result.missing.length) return { level: "info", event: "测试连接成功", detail: detail(listed) };
  return { level: "warn", event: "测试连接：模型不在列表中", detail: detail(listed, `列表中没有：${result.missing.join("、")}`) };
}
