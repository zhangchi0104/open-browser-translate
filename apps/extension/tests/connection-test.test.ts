import { strict as assert } from "node:assert";
import { test } from "node:test";
import { testConnection } from "../src/modules/background/ai/connection-test";
import { describeConnectionTest } from "../src/entrypoints/options/connection-test";

const models = (...ids: string[]) => Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });

/** A fetcher answering with `respond`, recording each request. */
function server(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { requests, fetcher };
}

test("a working connection lists its models once, with the key, at the base URL's /models", async () => {
  const { requests, fetcher } = server(() => models("mock-translator", "mock-analyzer"));
  const result = await testConnection({ apiUrl: "http://127.0.0.1:8787/v1/", apiKey: "sk-test", models: ["mock-translator"] }, { fetcher });
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" && result.models, 2);
  assert.deepEqual(result.status === "ok" && result.missing, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "http://127.0.0.1:8787/v1/models");
  assert.equal(requests[0]!.headers.get("Authorization"), "Bearer sk-test");
});

test("a keyless connection sends no Authorization header", async () => {
  const { requests, fetcher } = server(() => models("a"));
  await testConnection({ apiUrl: "http://localhost:11434/v1", apiKey: "" }, { fetcher });
  assert.equal(requests[0]!.url, "http://localhost:11434/v1/models");
  assert.equal(requests[0]!.headers.has("Authorization"), false);
});

test("models the connection uses that the list doesn't name come back as missing", async () => {
  const { fetcher } = server(() => models("gpt-a"));
  const result = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "k", models: ["gpt-a", "gpt-b", "gpt-b", " "] }, { fetcher });
  assert.deepEqual(result.status === "ok" && result.missing, ["gpt-b"]);
  assert.match(describeConnectionTest(result, { apiUrl: "https://example.com/v1", apiKey: "k" }).text, /没有 gpt-b/);
});

test("HTTP failures are classified by status, with the server's error message", async () => {
  const cases = [
    [401, { error: { message: "Incorrect API key provided" } }, "unauthorized"],
    [403, { error: "forbidden for this project" }, "unauthorized"],
    [404, { message: "Not Found" }, "not-found"],
    [429, { error: { message: "quota exceeded" } }, "http"],
    [502, "Bad Gateway", "http"],
  ] as const;
  for (const [status, body, reason] of cases) {
    const { fetcher } = server(() => typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }));
    const result = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "k" }, { fetcher });
    assert.equal(result.status, "error", `${status}`);
    if (result.status !== "error") continue;
    assert.equal(result.reason, reason, `${status}`);
    assert.equal(result.httpStatus, status);
    assert.equal(result.url, "https://example.com/v1/models");
  }
  const { fetcher } = server(() => Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }));
  const result = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "k" }, { fetcher });
  assert.equal(result.status === "error" && result.detail, "Incorrect API key provided");
});

test("a web page or a body that isn't a model list is reported as such", async () => {
  const page = server(() => new Response("<!doctype html><html><body>Welcome</body></html>", { headers: { "Content-Type": "text/html" } }));
  const html = await testConnection({ apiUrl: "https://example.com", apiKey: "" }, { fetcher: page.fetcher });
  assert.equal(html.status === "error" && html.reason, "html");

  const other = server(() => Response.json({ models: ["a"] }));
  const shape = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, { fetcher: other.fetcher });
  assert.equal(shape.status === "error" && shape.reason, "bad-response");
  assert.match(shape.status === "error" ? shape.detail ?? "" : "", /models/);

  const notFoundPage = server(() => new Response("<html>404</html>", { status: 404 }));
  const missing = await testConnection({ apiUrl: "https://example.com", apiKey: "" }, { fetcher: notFoundPage.fetcher });
  assert.equal(missing.status === "error" && missing.reason, "not-found");
  assert.equal(missing.status === "error" && missing.detail, undefined, "an HTML error page isn't quoted");
});

test("an unreachable server is a network failure, and a silent one times out", async () => {
  const down = await testConnection({ apiUrl: "http://127.0.0.1:1/v1", apiKey: "" }, {
    fetcher: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch,
  });
  assert.equal(down.status === "error" && down.reason, "network");
  assert.equal(down.status === "error" && down.detail, "Failed to fetch");

  const silent = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const started = Date.now();
  const timedOut = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, { fetcher: silent, timeoutMs: 20 });
  assert.equal(timedOut.status === "error" && timedOut.reason, "timeout");
  assert.ok(Date.now() - started < 1000);
});

test("an address that isn't an http(s) URL is rejected before any request", async () => {
  const { requests, fetcher } = server(() => models());
  for (const apiUrl of ["", "example.com/v1", "ftp://example.com/v1"]) {
    const result = await testConnection({ apiUrl, apiKey: "" }, { fetcher });
    assert.equal(result.status === "error" && result.reason, "invalid-url", apiUrl);
  }
  assert.equal(requests.length, 0);
});

test("messages say what to change", () => {
  const notFound = { status: "error", reason: "not-found", httpStatus: 404 } as const;
  assert.match(describeConnectionTest(notFound, { apiUrl: "http://127.0.0.1:8787", apiKey: "" }).text, /试试 http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.match(describeConnectionTest(notFound, { apiUrl: "https://example.com/v1/chat/completions", apiKey: "" }).text, /不要包含 \/chat\/completions/);
  assert.doesNotMatch(describeConnectionTest(notFound, { apiUrl: "https://openrouter.ai/api/v1", apiKey: "" }).text, /试试/);

  const unauthorized = { status: "error", reason: "unauthorized", httpStatus: 401, detail: "bad key" } as const;
  assert.match(describeConnectionTest(unauthorized, { apiUrl: "https://example.com/v1", apiKey: "" }).text, /需要 API key（401）.*bad key/);
  assert.match(describeConnectionTest(unauthorized, { apiUrl: "https://example.com/v1", apiKey: "k" }).text, /API key 无效/);

  const ok = describeConnectionTest({ status: "ok", models: 2, ms: 12, missing: [] }, { apiUrl: "https://example.com/v1", apiKey: "" });
  assert.deepEqual(ok, { text: "连接成功：服务列出了 2 个模型，用时 12 毫秒。", tone: "success" });
  assert.equal(describeConnectionTest({ status: "failed" }, { apiUrl: "", apiKey: "" }).tone, "error");
});
