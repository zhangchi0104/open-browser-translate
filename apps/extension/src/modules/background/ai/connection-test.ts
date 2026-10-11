import { Effect } from "effect";
import { markFailed } from "../../shared/debug-log/trace";
import type { ConnectionApi, ConnectionTestFailure, ConnectionTestResult } from "../../shared/protocol";
import { anthropicHeaders } from "./endpoints";

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
 * Where each kind of API lists models, and how it takes the key. OpenRouter's `/models` is public,
 * so a test asks `/models/user`, which needs the key.
 */
const bearer = (apiKey: string): Record<string, string> => apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
const MODEL_LISTS: Record<ConnectionApi, { path: string; headers: (apiKey: string) => Record<string, string> }> = {
  openai: { path: "/models", headers: bearer },
  openrouter: { path: "/models/user", headers: bearer },
  anthropic: { path: "/v1/models?limit=1000", headers: anthropicHeaders },
};

/**
 * Lists the models at `apiUrl` with `apiKey` (none when empty) once, to tell whether the connection
 * works and, when it doesn't, why. `api` says how that API lists models (OpenAI-compatible unless
 * given). `models` are model IDs the connection is used with; those the list doesn't name come
 * back as `missing`.
 */
export async function testConnection(
  { apiUrl, apiKey, models = [], api = "openai" }: { apiUrl: string; apiKey: string; models?: readonly string[]; api?: ConnectionApi },
  { fetcher = fetch, timeoutMs = CONNECTION_TEST_TIMEOUT_MS }: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<ConnectionTestResult> {
  let url: URL;
  try {
    url = new URL(`${apiUrl.trim().replace(/\/+$/, "")}${MODEL_LISTS[api].path}`);
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
    response = await fetcher(url.href, { headers: MODEL_LISTS[api].headers(apiKey), signal: controller.signal });
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
  return { status: "ok", models: ids.length, ms, missing, url: url.href, httpStatus: response.status };
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
 * A console line for a test: what was asked (never the key, only whether there was one) and
 * everything that came back. The trace holds the same; this is for reading the worker's console.
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

type ConnectionTestRequest = { apiUrl: string; apiKey: string; models?: readonly string[]; api?: ConnectionApi };

/** Records a long text on the current span as an event, which the trace view shows as a block. */
const note = (name: string, content: string | undefined) => content === undefined ? Effect.void : Effect.currentSpan.pipe(
  Effect.tap((span) => Effect.sync(() => span.event(name, BigInt(Date.now()) * 1_000_000n, { content }))),
  Effect.ignore,
);

/** How a failed test reads in the trace: its reason and, when there was one, the HTTP status. */
const failureText = (result: Extract<ConnectionTestResult, { status: "error" }>) =>
  `测试连接失败：${result.reason}${result.httpStatus !== undefined ? `（HTTP ${result.httpStatus}）` : ""}`;

/** What was asked, as span attributes: the address, whether there was a key (never the key) and the models. */
const requestAttributes = ({ apiUrl, apiKey, models = [], api = "openai" }: ConnectionTestRequest) => ({
  "obt.connection.api_url": apiUrl,
  "obt.connection.api": api,
  "obt.connection.has_key": !!apiKey,
  ...(models.length && { "obt.connection.models": [...models] }),
});

/**
 * `testConnection` as a traced request, like translation's: a `test-connection` root span with
 * what was asked and how it went, and a `connection.list-models` client span for the request to
 * the server, carrying the HTTP status, the server's message and the response body. A failed test
 * marks both spans failed, so it's listed under errors.
 */
export const traceConnectionTest = (request: ConnectionTestRequest, options?: Parameters<typeof testConnection>[1]) =>
  Effect.gen(function* () {
    const root = yield* Effect.orDie(Effect.currentSpan);
    const result = yield* Effect.gen(function* () {
      const span = yield* Effect.orDie(Effect.currentSpan);
      const result = yield* Effect.promise(() => testConnection(request, options));
      yield* Effect.annotateCurrentSpan({
        ...(result.url && { "url.full": result.url }),
        ...(result.httpStatus !== undefined && { "http.response.status_code": result.httpStatus }),
      });
      if (result.status === "ok") return result;
      yield* Effect.annotateCurrentSpan({ "error.type": result.reason });
      yield* note("obt.server.message", result.detail);
      yield* note("obt.response.body", result.body);
      markFailed(span, failureText(result));
      return result;
    }).pipe(Effect.withSpan("connection.list-models", { kind: "client", attributes: { "http.request.method": "GET" } }));
    if (result.status === "ok") {
      yield* Effect.annotateCurrentSpan({
        "obt.test.result": "ok",
        "obt.test.models_listed": result.models,
        ...(result.missing.length && { "obt.test.missing": [...result.missing] }),
      });
    } else {
      yield* Effect.annotateCurrentSpan({ "obt.test.result": "error", "obt.test.reason": result.reason });
      markFailed(root, failureText(result));
    }
    const { level, detail } = connectionTestLog(request, result);
    console[level](`[test-connection] ${detail}`);
    return result;
  }).pipe(Effect.withSpan("test-connection", { kind: "server", attributes: requestAttributes(request) }));

const failureStages: Record<ConnectionTestFailure["stage"], string> = {
  permission: "没有获得访问接口的权限",
  send: "请求没有送到扩展后台",
  reply: "后台没有返回可用的结果",
};

/**
 * A test that failed on the options page before or after the background ran it (permission
 * refused, the request not delivered, a reply that didn't decode), recorded as a failed
 * `test-connection` trace so it's listed with the others. Only the page saw it, so the page reports it.
 */
export const recordConnectionTestFailure = ({ apiUrl, hasKey, stage, error, elapsedMs }: ConnectionTestFailure) =>
  Effect.gen(function* () {
    const span = yield* Effect.orDie(Effect.currentSpan);
    console.warn(`[test-connection] ${failureStages[stage]}：${apiUrl}\n${error}`);
    markFailed(span, `测试连接失败：${failureStages[stage]}`, new Error(error));
  }).pipe(Effect.withSpan("test-connection", {
    kind: "server",
    attributes: {
      "obt.connection.api_url": apiUrl,
      "obt.connection.has_key": hasKey,
      "obt.test.result": "error",
      "obt.test.reason": `page-${stage}`,
      "obt.test.page_elapsed_ms": elapsedMs,
    },
  }));
