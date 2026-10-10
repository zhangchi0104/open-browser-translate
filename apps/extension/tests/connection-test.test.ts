import { strict as assert } from "node:assert";
import { test } from "node:test";
import { connectionTestLog, testConnection } from "../src/modules/background/ai/connection-test";
import { describeConnectionTest } from "../src/entrypoints/options/connection-test";
import { createClient, createDispatcher, type ConnectionTestResult, type Handlers, type Sender } from "../src/modules/shared/protocol";

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
  assert.equal(result.status === "error" && result.body, '{"error":{"message":"Incorrect API key provided"}}');
});

test("a long server message and body are kept, up to a stated limit", async () => {
  const message = "x".repeat(1000);
  const { fetcher } = server(() => Response.json({ error: { message } }, { status: 400 }));
  const result = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, { fetcher });
  assert.equal(result.status === "error" && result.detail, message);

  const huge = server(() => new Response("y".repeat(10_000), { status: 500 }));
  const clipped = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, { fetcher: huge.fetcher });
  assert.match(clipped.status === "error" ? clipped.body ?? "" : "", /^y{4000}\n（共 10000 个字符，只保留前 4000 个）$/);
});

test("a web page or a body that isn't a model list is reported as such", async () => {
  const page = server(() => new Response("<!doctype html><html><body>Welcome</body></html>", { headers: { "Content-Type": "text/html" } }));
  const html = await testConnection({ apiUrl: "https://example.com", apiKey: "" }, { fetcher: page.fetcher });
  assert.equal(html.status === "error" && html.reason, "html");

  const other = server(() => Response.json({ models: ["a"] }));
  const shape = await testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, { fetcher: other.fetcher });
  assert.equal(shape.status === "error" && shape.reason, "bad-response");
  assert.equal(shape.status === "error" && shape.body, '{"models":["a"]}');

  const notFoundPage = server(() => new Response("<html>404</html>", { status: 404 }));
  const missing = await testConnection({ apiUrl: "https://example.com", apiKey: "" }, { fetcher: notFoundPage.fetcher });
  assert.equal(missing.status === "error" && missing.reason, "not-found");
  assert.equal(missing.status === "error" && missing.detail, undefined, "an HTML page has no error message");
  assert.equal(missing.status === "error" && missing.body, "<html>404</html>");
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

/** Every result `testConnection` can return, each produced by the real function. */
async function everyResult(): Promise<ConnectionTestResult[]> {
  const run = (respond: () => Response | Promise<Response>, apiUrl = "https://example.com/v1") =>
    testConnection({ apiUrl, apiKey: "k", models: ["gpt-a", "gpt-z"] }, { fetcher: server(respond).fetcher });
  const results = await Promise.all([
    run(() => models("gpt-a", "gpt-z")),
    run(() => models("gpt-a")),
    run(() => models(), "not a url"),
    run(() => { throw new TypeError("Failed to fetch"); }),
    testConnection({ apiUrl: "https://example.com/v1", apiKey: "" }, {
      timeoutMs: 5,
      fetcher: ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch,
    }),
    run(() => Response.json({ error: { message: "bad key" } }, { status: 401 })),
    run(() => new Response("", { status: 404 })),
    run(() => new Response("<html></html>", { headers: { "Content-Type": "text/html" } })),
    run(() => Response.json({ object: "list" })),
    run(() => new Response("Bad Gateway", { status: 502 })),
  ]);
  const variants = new Set(results.map((result) => result.status === "ok" ? `ok:${result.missing.length}` : result.reason));
  assert.equal(variants.size, results.length, "each case is a different variant");
  return results;
}

/** Both ends of the real protocol, with each message serialized as extension messaging does. */
function messaging(reply: () => unknown, serialize: (value: unknown) => unknown) {
  const handlers = new Proxy({} as Handlers, { get: () => reply });
  const dispatcher = createDispatcher({ trusted: () => true, handlers, translate: async () => ({ status: "failed" }) });
  const sender: Sender = { id: "extension", url: "chrome-extension://extension/options.html" };
  return createClient({
    sendMessage: (message) => new Promise((resolve) => {
      if (!dispatcher.onMessage(serialize(message), sender, (response) => resolve(serialize(response)))) resolve(undefined);
    }),
    connect: () => { throw new Error("no stream"); },
  });
}

const serializations = {
  json: (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
  "structured clone": (value: unknown) => structuredClone(value),
};

test("every test result reaches the options page intact through the real protocol, serialized either way", async () => {
  const results = await everyResult();
  for (const [name, serialize] of Object.entries(serializations)) {
    for (const result of results) {
      const client = messaging(() => result, serialize);
      const received = await client.request({ type: "test-connection", apiUrl: "https://example.com/v1", apiKey: "k", models: ["gpt-a"] });
      assert.deepEqual(received, result, `${name}: ${JSON.stringify(result)}`);
    }
  }
});

test("a request no handler answers says the background may be out of date, with the schema error and the raw reply", async () => {
  const unanswered = createClient({ sendMessage: async () => undefined, connect: () => { throw new Error("no stream"); } });
  const result = await unanswered.request({ type: "test-connection", apiUrl: "https://example.com/v1", apiKey: "" });
  assert.equal(result.status, "failed");
  const error = result.status === "failed" ? result.error ?? "" : "";
  assert.match(error, /后台没有回应「test-connection」请求，可能还在运行旧版本的扩展/);
  assert.match(error, /「test-connection」的回复无法识别：Expected/);
  assert.match(error, /收到的回复：undefined$/);
  assert.equal(describeConnectionTest(result, { apiUrl: "https://example.com/v1", apiKey: "" }).details, error, "the page shows the whole error");
});

test("a malformed reply names the field that's wrong and quotes the reply", async () => {
  const client = messaging(() => ({ status: "error", reason: "weird", url: "u" }), serializations.json);
  const result = await client.request({ type: "test-connection", apiUrl: "u", apiKey: "" });
  const error = result.status === "failed" ? result.error ?? "" : "";
  assert.match(error, /at \["reason"\]/);
  assert.match(error, /收到的回复：\{"status":"error","reason":"weird","url":"u"\}/);
});

test("a failed test's details hold the request, status, message and body", () => {
  const message = describeConnectionTest(
    { status: "error", reason: "http", url: "https://example.com/v1/models", httpStatus: 400, detail: "bad request", body: '{"error":"bad request"}' },
    { apiUrl: "https://example.com/v1", apiKey: "" },
  );
  assert.equal(message.details, '请求：GET https://example.com/v1/models\nHTTP 状态：400\n说明：bad request\n响应内容：\n{"error":"bad request"}');
  assert.equal(describeConnectionTest({ status: "ok", models: 1, ms: 1, missing: [] }, { apiUrl: "u", apiKey: "" }).details, undefined);
});

test("the debug log gets every result, with the key left out", async () => {
  for (const result of await everyResult()) {
    const entry = connectionTestLog({ apiUrl: "https://example.com/v1", apiKey: "sk-test-value", models: ["gpt-a"] }, result);
    assert.doesNotMatch(entry.detail, /sk-test-value/);
    assert.match(entry.detail, /^接口地址：https:\/\/example\.com\/v1\nAPI key：已填写/);
    if (result.status !== "error") continue;
    assert.equal(entry.level, "warn");
    assert.equal(entry.event, `测试连接失败：${result.reason}`);
    if (result.body) assert.ok(entry.detail.includes(result.body));
    if (result.detail) assert.ok(entry.detail.includes(result.detail));
  }
});
