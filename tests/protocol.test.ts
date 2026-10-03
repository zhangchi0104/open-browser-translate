import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createClient, createDispatcher, MAX_BATCH_BLOCKS, PAGE_CONTEXT_LIMITS, STREAM_PORT,
  type Block, type Handlers, type Port, type Sender,
} from "../src/modules/protocol";
import type { TranslationBatchResult } from "../src/modules/translator/translate-batch";

const PAGE: Sender = { id: "extension", tab: { url: "https://example.com/a" } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One end of a fake port pair. Messages are cloned and arrive later, and `disconnect` only tells the other side, as in browsers. */
class FakePort implements Port {
  private readonly messages: ((message: unknown) => void)[] = [];
  private readonly disconnects: (() => void)[] = [];
  other!: FakePort;
  open = true;
  constructor(readonly name: string, readonly sender?: Sender) {}
  postMessage(message: unknown) {
    if (!this.open) throw new Error("Attempting to use a disconnected port object");
    const copy = structuredClone(message);
    setTimeout(() => { if (this.open) for (const listener of this.other.messages) listener(copy); }, 0);
  }
  disconnect() {
    if (!this.open) return;
    this.open = this.other.open = false;
    setTimeout(() => { for (const listener of this.other.disconnects) listener(); }, 0);
  }
  readonly onMessage = { addListener: (listener: (message: unknown) => void) => { this.messages.push(listener); } };
  readonly onDisconnect = { addListener: (listener: () => void) => { this.disconnects.push(listener); } };
}

/** The page's end and the background's end of a new port. */
function portPair(name: string, sender: Sender): [FakePort, FakePort] {
  const page = new FakePort(name);
  const background = new FakePort(name, sender);
  page.other = background;
  background.other = page;
  return [page, background];
}

function connect(options: Parameters<typeof createDispatcher>[0], sender = PAGE) {
  const dispatcher = createDispatcher(options);
  const ports: Port[] = [];
  const client = createClient({
    sendMessage: (message) => Promise.resolve(dispatcher.onMessage(structuredClone(message), sender)),
    connect: ({ name }) => {
      const [page, background] = portPair(name, sender);
      ports.push(background);
      dispatcher.onConnect(background);
      return page;
    },
  });
  return { client, dispatcher, backgroundPorts: ports };
}

/** Handlers that fail the test if called, with `overrides` for the ones it uses. */
function handlers(overrides: Partial<Handlers>): Handlers {
  return new Proxy(overrides as Handlers, {
    get: (target, type: string) => target[type as keyof Handlers] ?? (() => assert.fail(`unexpected ${type} request`)),
  });
}

const noTranslate = async (): Promise<TranslationBatchResult> => assert.fail("unexpected translation");

test("a request reaches its handler decoded, and the reply comes back typed", async () => {
  const seen: unknown[] = [];
  const { client } = connect({
    trusted: () => true,
    translate: noTranslate,
    handlers: handlers({
      "analyze-content": ({ mode, blocks }, sender) => {
        seen.push({ mode, blocks, url: sender.tab?.url });
        return { status: "ok", blocks: blocks.map(() => ({ keep: true, priority: 0 })), fallbackCount: 0 };
      },
    }),
  });
  const reply = await client.request({ type: "analyze-content", mode: "main", blocks: [{ text: "Hello", tag: "p" }] });
  assert.deepEqual(reply, { status: "ok", blocks: [{ keep: true, priority: 0 }], fallbackCount: 0 });
  assert.deepEqual(seen, [{ mode: "main", blocks: [{ text: "Hello", tag: "p" }], url: "https://example.com/a" }]);
});

test("requests over the limits, or malformed, fail without reaching a handler", async () => {
  const invalid: string[] = [];
  const { client } = connect({
    trusted: () => true,
    translate: noTranslate,
    handlers: handlers({}),
    onInvalid: (type) => invalid.push(type),
  });
  const block: Block = { text: "x", tag: "p" };
  const context = { title: "T", sample: "S", hasArticle: false, pagination: [] as string[] };
  for (const message of [
    { type: "analyze-content", mode: "all", blocks: Array.from({ length: MAX_BATCH_BLOCKS + 1 }, () => block) },
    { type: "analyze-content", mode: "all", blocks: [{ text: "x".repeat(200_001), tag: "p" }] },
    { type: "analyze-content", mode: "everything", blocks: [block] },
    { type: "prepare-translation", context: { ...context, title: "x".repeat(PAGE_CONTEXT_LIMITS.title + 1) } },
    { type: "prepare-translation", context: { ...context, pagination: Array.from({ length: PAGE_CONTEXT_LIMITS.pagination + 1 }, () => "1") } },
    { type: "debug-log", entry: { level: "fatal", event: "x" } },
  ]) {
    assert.deepEqual(await client.request(message as never), { status: "failed" }, JSON.stringify(message).slice(0, 80));
  }
  assert.deepEqual(invalid, ["analyze-content", "analyze-content", "analyze-content", "prepare-translation", "prepare-translation", "debug-log"]);
});

test("unknown request types and untrusted senders get no answer", async () => {
  const { dispatcher } = connect({ trusted: (sender) => sender.id === "extension", translate: noTranslate, handlers: handlers({ "cache-stats": () => ({ status: "ok", count: 1 }) }) });
  assert.equal(dispatcher.onMessage({ type: "something-else" }, PAGE), undefined);
  assert.equal(dispatcher.onMessage({ type: "cache-stats" }, { id: "another-extension" }), undefined);
  assert.deepEqual(await dispatcher.onMessage({ type: "cache-stats" }, PAGE), { status: "ok", count: 1 });
});

test("a streamed batch delivers cached and growing blocks in order, then resolves once with the result", async () => {
  let sender: Sender | undefined;
  const { client } = connect({
    trusted: () => true,
    handlers: handlers({}),
    translate: async (blocks, from, onBlock) => {
      sender = from;
      onBlock(1, "缓存", true);
      onBlock(0, "你", false);
      onBlock(0, "你好", false);
      return { status: "ok", translations: ["你好", "缓存"], terms: [] };
    },
  });
  const events: [number, string, boolean][] = [];
  const result = await client.translate([{ text: "Hello", tag: "p" }, { text: "Cached", tag: "p" }], (...event) => events.push(event));
  assert.deepEqual(events, [[1, "缓存", true], [0, "你", false], [0, "你好", false]]);
  assert.deepEqual(result, { status: "ok", translations: ["你好", "缓存"], terms: [] });
  assert.equal(sender?.tab?.url, "https://example.com/a", "the port's sender, not the message, says which page asked");
});

test("losing the background mid-batch fails the batch; an oversized batch fails without translating", async () => {
  const { client, backgroundPorts } = connect({
    trusted: () => true,
    handlers: handlers({}),
    translate: (_blocks, _sender, onBlock) => {
      onBlock(0, "你", false);
      return new Promise(() => {});
    },
  });
  const events: unknown[] = [];
  const pending = client.translate([{ text: "Hello", tag: "p" }], (...event) => events.push(event));
  await tick();
  await tick();
  backgroundPorts[0]!.disconnect();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error ?? "" : "", /连接中断/);
  assert.deepEqual(events, [[0, "你", false]]);

  const oversized = await client.translate(Array.from({ length: MAX_BATCH_BLOCKS + 1 }, () => ({ text: "x", tag: "p" })), () => assert.fail("no blocks"));
  assert.deepEqual(oversized, { status: "failed" });
});

test("only the translation port from a trusted sender is served", async () => {
  let calls = 0;
  const dispatcher = createDispatcher({ trusted: (sender) => sender.id === "extension", handlers: handlers({}), translate: async () => { calls++; return { status: "failed" }; } });
  for (const [name, sender] of [["other-port", PAGE], [STREAM_PORT, { id: "another-extension" }]] as const) {
    const [page, background] = portPair(name, sender);
    dispatcher.onConnect(background);
    page.postMessage({ blocks: [] });
  }
  await tick();
  assert.equal(calls, 0);
});
