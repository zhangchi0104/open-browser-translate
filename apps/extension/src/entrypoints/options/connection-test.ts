import type { ConnectionTestResult, Failed } from "@/modules/shared/protocol";
import { failureDetails } from "@/modules/background/ai/connection-test";

export interface TestMessage {
  text: string;
  tone: "error" | "success" | "warning";
  /** Everything that came back, in full: the request, status, server message and body, or the page's own error. */
  details?: string;
}

/** Whether a base URL's path names an API version, as `/v1`, `/api/v1` or `/v1beta/openai` do. */
const hasVersion = (url: URL) => /\/v\d+[a-z0-9]*(\/|$)/i.test(url.pathname);

/** What to change in `apiUrl` when the server has no model list there. */
function pathHint(apiUrl: string): string {
  let url: URL;
  try { url = new URL(apiUrl); } catch { return "请检查接口地址。"; }
  if (/\/(chat\/completions|completions|models|responses)\/?$/.test(url.pathname)) {
    return "接口地址只填到 /v1 这一级，不要包含 /chat/completions 等具体路径。";
  }
  if (!hasVersion(url)) return `接口地址通常以 /v1 结尾，试试 ${apiUrl.replace(/\/+$/, "")}/v1。`;
  return "请检查接口地址是否正确。";
}

const withDetail = (text: string, detail: string | undefined) => detail ? `${text}服务返回：${detail}` : text;

function httpFailure(status = 0): string {
  if (status === 429) return "请求过多或额度不足（429），请稍后再试或检查账户余额。";
  if (status >= 500) return `服务出错（${status}），请稍后再试。`;
  return `服务拒绝了请求（${status}）。`;
}

/** What a failed test got back, line by line; nothing for a passed one. */
function detailsOf(result: ConnectionTestResult | Failed): string | undefined {
  if (result.status === "ok") return;
  if (result.status === "failed") return result.error ?? "扩展后台没有回应，也没有说明原因。";
  return failureDetails(result) || undefined;
}

/**
 * What a connection test found, in words for the options page: success with the model count and
 * time, or what failed and what to try, with everything that came back as `details`. `apiUrl` and
 * `apiKey` are what was tested.
 */
export function describeConnectionTest(result: ConnectionTestResult | Failed, tested: { apiUrl: string; apiKey: string }): TestMessage {
  const details = detailsOf(result);
  return { ...summarize(result, tested), ...(details && { details }) };
}

function summarize(result: ConnectionTestResult | Failed, { apiUrl, apiKey }: { apiUrl: string; apiKey: string }): Omit<TestMessage, "details"> {
  if (result.status === "failed") return { text: "测试没有完成。下面是完整的错误信息，「调试日志」→「请求追踪」中也有记录。", tone: "error" };
  if (result.status === "ok") {
    if (result.missing.length) {
      return {
        text: `连接成功，但服务列出的 ${result.models} 个模型中没有 ${result.missing.join("、")}。使用时可能会失败，请在「语言与模型」中检查模型 ID。`,
        tone: "warning",
      };
    }
    return { text: `连接成功：服务列出了 ${result.models} 个模型，用时 ${result.ms} 毫秒。`, tone: "success" };
  }
  const origin = (() => { try { return new URL(apiUrl).origin; } catch { return apiUrl; } })();
  switch (result.reason) {
    case "invalid-url":
      return { text: "请填写以 https:// 或 http:// 开头的接口地址。", tone: "error" };
    case "network":
      return { text: `无法连接到 ${origin}：请检查地址是否正确、服务是否正在运行。${result.detail ? `（${result.detail}）` : ""}`, tone: "error" };
    case "timeout":
      return { text: `${origin} 长时间没有响应：服务可能没有运行，或这台设备的网络无法访问它。`, tone: "error" };
    case "unauthorized":
      return {
        text: withDetail(apiKey
          ? `API key 无效或没有权限（${result.httpStatus}）。请检查 key 是否完整、是否属于这个服务。`
          : `这个接口需要 API key（${result.httpStatus}），请填写后再测试。`, result.detail),
        tone: "error",
      };
    case "not-found":
      return { text: `这个地址下找不到模型列表（404）。${pathHint(apiUrl)}`, tone: "error" };
    case "html":
      return { text: `这个地址返回的是网页，不是 OpenAI 兼容接口。${pathHint(apiUrl)}`, tone: "error" };
    case "bad-response":
      return { text: withDetail("服务有回应，但不是 OpenAI 兼容的模型列表。请确认接口地址指向 OpenAI 兼容接口。", result.detail), tone: "error" };
    case "http":
      return { text: withDetail(httpFailure(result.httpStatus), result.detail), tone: "error" };
  }
}
