import { Result, Schema } from "effect";
import { TermPair } from "../translation-context";

// Everything the page, the options page and the background say to each other. Requests and
// replies are schemas: the background decodes each request, limits included, before a handler
// sees it, and pages decode each reply. Pages talk through `createClient`, the background answers
// through `createDispatcher`, and both take the browser's runtime as an adapter so tests can
// connect them directly.

/** Blocks per batch: one analysis request, and one translation request at most. */
export const MAX_BATCH_BLOCKS = 8;
/** Characters per batch, all blocks together. */
export const MAX_BATCH_CHARS = 200_000;
/** What the page may send about itself for planning. */
export const PAGE_CONTEXT_LIMITS = { title: 1000, sample: 12_000, pagination: 20, paginationLabel: 100 } as const;

export const Mode = Schema.Literals(["all", "main"]);
export type Mode = typeof Mode.Type;

/** A piece of page text translated as one unit, with the tag it came from. */
export const Block = Schema.Struct({ text: Schema.String, tag: Schema.String });
export type Block = typeof Block.Type;

/** Characters in a batch, all blocks together. */
export const batchChars = (blocks: readonly Block[]) => blocks.reduce((sum, block) => sum + block.text.length, 0);

const Batch = Schema.Array(Block).check(
  Schema.isMaxLength(MAX_BATCH_BLOCKS),
  Schema.makeFilter((blocks: readonly Block[]) => {
    const chars = batchChars(blocks);
    return chars <= MAX_BATCH_CHARS || `${chars} characters is over ${MAX_BATCH_CHARS}`;
  }),
);

/** What a model is for: deciding what to translate, or translating it. */
export const Purpose = Schema.Literals(["analysis", "translation"]);
export type Purpose = typeof Purpose.Type;

/** How each purpose is named to the reader. */
export const PURPOSE_NAMES: Record<Purpose, string> = { analysis: "内容分析", translation: "翻译" };

/** Bounded samples of the page, so the plan can be decided without sending the whole page. */
export const PageContext = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(PAGE_CONTEXT_LIMITS.title)),
  sample: Schema.String.check(Schema.isMaxLength(PAGE_CONTEXT_LIMITS.sample)),
  hasArticle: Schema.Boolean,
  pagination: Schema.Array(Schema.String.check(Schema.isMaxLength(PAGE_CONTEXT_LIMITS.paginationLabel)))
    .check(Schema.isMaxLength(PAGE_CONTEXT_LIMITS.pagination)),
});
export type PageContext = typeof PageContext.Type;

const PageLog = Schema.Struct({
  level: Schema.Literals(["info", "warn", "error"]),
  event: Schema.String.check(Schema.isMaxLength(200)),
  detail: Schema.optional(Schema.String),
});

const request = <const T extends string, const F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields });

/** Every request a page can send with `runtime.sendMessage`, by `type`. */
export const Requests = {
  "open-settings": request("open-settings", {}),
  "debug-log": request("debug-log", { entry: PageLog }),
  "debug-log-clear": request("debug-log-clear", {}),
  "traces-clear": request("traces-clear", {}),
  "cache-stats": request("cache-stats", {}),
  "cache-clear": request("cache-clear", {}),
  "chatgpt-sign-in": request("chatgpt-sign-in", {}),
  "chatgpt-sign-out": request("chatgpt-sign-out", {}),
  "chatgpt-models": request("chatgpt-models", {}),
  /** `apiKey` is the key being edited on the options page; the saved one otherwise. */
  "openai-models": request("openai-models", { apiKey: Schema.optional(Schema.String) }),
  "gateway-models": request("gateway-models", {}),
  "prepare-translation": request("prepare-translation", { context: PageContext }),
  "analyze-content": request("analyze-content", { mode: Mode, blocks: Batch }),
};
type RequestType = keyof typeof Requests;
export type Request<K extends RequestType = RequestType> = { [T in K]: typeof Requests[T]["Type"] }[K];
const isRequestType = (type: string): type is RequestType => Object.hasOwn(Requests, type);

const status = <const S extends string, const F extends Schema.Struct.Fields>(value: S, fields: F) =>
  Schema.Struct({ status: Schema.Literal(value), ...fields });
const Ok = status("ok", {});
/** Also the reply to any request that doesn't decode. */
const Failed = status("failed", { error: Schema.optional(Schema.String) });
export type Failed = typeof Failed.Type;
const NotConfigured = status("not-configured", { purpose: Purpose });
const ModelList = Schema.Union([status("ok", { models: Schema.Array(Schema.Struct({ slug: Schema.String, displayName: Schema.String })) }), Failed]);
export type ModelList = typeof ModelList.Type;

/** How the analysis model decided to translate a page. */
export const TranslationPlan = Schema.Struct({
  mode: Mode,
  navigation: Schema.Literals(["single", "paginated", "dynamic"]),
  fallback: Schema.Boolean,
  /** Why planning failed, when it did. */
  error: Schema.optional(Schema.String),
});
export type TranslationPlan = typeof TranslationPlan.Type;

/** Analysis of a batch: whether to translate each block, and when relative to the others. */
export const PageAnalysisResult = Schema.Union([
  status("ok", { blocks: Schema.Array(Schema.Struct({ keep: Schema.Boolean, priority: Schema.Number })), fallbackCount: Schema.Number }),
  NotConfigured,
  Failed,
]);
export type PageAnalysisResult = typeof PageAnalysisResult.Type;

/** A translated batch: one translation per block, in order, when it's ok. */
export const TranslationBatchResult = Schema.Union([
  status("ok", {
    translations: Schema.Array(Schema.String),
    terms: Schema.Array(TermPair),
    /** How many blocks the page's batch found in the cache. */
    cacheHits: Schema.optional(Schema.Number),
  }),
  NotConfigured,
  Failed,
]);
export type TranslationBatchResult = typeof TranslationBatchResult.Type;

/** The reply to each request. */
const Replies = {
  "open-settings": Schema.Struct({ opened: Schema.Literal(true) }),
  "debug-log": Schema.Undefined,
  "debug-log-clear": Ok,
  "traces-clear": Ok,
  "cache-stats": Schema.Union([status("ok", { count: Schema.Number }), Failed]),
  "cache-clear": Schema.Union([Ok, Failed]),
  "chatgpt-sign-in": status("started", { state: Schema.String }),
  "chatgpt-sign-out": Ok,
  "chatgpt-models": ModelList,
  "openai-models": Schema.Union([ModelList, status("no-key", {})]),
  "gateway-models": ModelList,
  "prepare-translation": Schema.Union([status("ok", { plan: TranslationPlan }), NotConfigured, Failed]),
  "analyze-content": PageAnalysisResult,
};
type Reply<K extends RequestType> = typeof Replies[K]["Type"];
export type Response<K extends RequestType> = Reply<K> | Failed;
const decodeReply = <K extends RequestType>(type: K, reply: unknown): Result.Result<Response<K>, Schema.SchemaError> =>
  Schema.decodeUnknownResult(Schema.Union([Replies[type], Failed]))(reply);

// Streaming translation: the page opens a port, sends one batch, and receives each block's
// text as it's written (or at once and final when it was cached), then the result.
export const STREAM_PORT = "translate-stream";
const StreamRequest = Schema.Struct({ blocks: Batch });
/** Receives a block's text by index in its batch; `final` once it won't change (cached, or validated). */
export type OnBlock = (index: number, text: string, final: boolean) => void;
const StreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("block"), index: Schema.Number, text: Schema.String, final: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("result"), result: TranslationBatchResult }),
]);
type StreamEvent = typeof StreamEvent.Type;

/** The slice of a browser runtime `Port` both sides use. */
export interface Port {
  readonly name: string;
  readonly sender?: Sender;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}
export interface Sender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: { readonly url?: string; readonly incognito?: boolean };
}

/** The page side, over `browser.runtime` (or a fake in tests). */
export function createClient(runtime: {
  sendMessage(message: unknown): Promise<unknown>;
  connect(info: { name: string }): Port;
  readonly lastError?: { message?: string } | null;
}) {
  return {
    /** Sends a request; rejects only when the message can't be delivered. A reply that doesn't decode is a failure. */
    async request<M extends Request>(message: M): Promise<Response<M["type"]>> {
      const reply = decodeReply(message.type, await runtime.sendMessage(message));
      return Result.isSuccess(reply) ? reply.success : { status: "failed", error: String(reply.failure) };
    },

    /**
     * Translates a batch over the stream port. `onBlock` receives each block's text by index in
     * `blocks`: final at once when it came from the cache, otherwise growing as it's written.
     * Resolves once with the result; losing the background (extension reloaded, worker stopped)
     * resolves it as failed.
     */
    translate(blocks: readonly Block[], onBlock: OnBlock): Promise<TranslationBatchResult> {
      return new Promise((resolve) => {
        let settled = false;
        let port: Port | undefined;
        const finish = (result: TranslationBatchResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
          try { port?.disconnect(); } catch {}
        };
        try {
          port = runtime.connect({ name: STREAM_PORT });
        } catch (error) {
          return finish({ status: "failed", error: `无法连接后台：${error instanceof Error ? error.message : String(error)}` });
        }
        port.onMessage.addListener((message) => {
          const event = Schema.decodeUnknownResult(StreamEvent)(message);
          if (Result.isFailure(event)) return finish({ status: "failed", error: `后台发来无法识别的消息：${String(event.failure)}` });
          if (event.success.type === "block") onBlock(event.success.index, event.success.text, event.success.final);
          else finish(event.success.result);
        });
        port.onDisconnect.addListener(() => finish({ status: "failed", error: `与后台的连接中断：${runtime.lastError?.message ?? "未知原因"}` }));
        port.postMessage({ blocks: blocks.map(({ text, tag }) => ({ text, tag })) });
      });
    },
  };
}

/** Answers one request type; the request has already been decoded. */
export type Handlers = {
  [K in RequestType]: (request: Request<K>, sender: Sender) => Promise<Reply<K>> | Reply<K>;
};

/**
 * The background side. Messages from senders `trusted` rejects, and types no handler knows, get
 * no answer; a request that doesn't decode gets `{ status: "failed" }` and goes to `onInvalid`.
 * `translate` serves the stream port.
 */
export function createDispatcher(options: {
  trusted: (sender: Sender) => boolean;
  handlers: Handlers;
  translate: (blocks: readonly Block[], sender: Sender, onBlock: OnBlock) => Promise<TranslationBatchResult>;
  onInvalid?: (type: string, error: string) => void;
}) {
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, type: string, value: unknown): S["Type"] | undefined => {
    const result = Schema.decodeUnknownResult(schema)(value);
    if (Result.isSuccess(result)) return result.success;
    options.onInvalid?.(type, String(result.failure));
  };
  const answer = async <K extends RequestType>(type: K, message: unknown, sender: Sender): Promise<Response<K>> => {
    const request: Schema.Codec<Request<K>> = Requests[type];
    const decoded = decode(request, type, message);
    return decoded === undefined ? { status: "failed" } : options.handlers[type](decoded, sender);
  };
  return {
    /**
     * For `runtime.onMessage`. Answers through `sendResponse` and returns true when it will, the
     * form every browser supports (Chrome doesn't deliver a promise a listener returns everywhere).
     */
    onMessage(message: unknown, sender: Sender, sendResponse: (response: unknown) => void): boolean {
      if (!options.trusted(sender) || typeof message !== "object" || message === null || !("type" in message)) return false;
      const { type } = message;
      if (typeof type !== "string" || !isRequestType(type)) return false;
      answer(type, message, sender).then(sendResponse, (error) => sendResponse({ status: "failed", error: String(error) } satisfies Failed));
      return true;
    },

    /** For `runtime.onConnect`. */
    onConnect(port: Port) {
      const sender = port.sender;
      if (port.name !== STREAM_PORT || !sender || !options.trusted(sender)) return;
      let open = true;
      port.onDisconnect.addListener(() => { open = false; });
      const post = (event: StreamEvent) => { if (open) port.postMessage(event); };
      port.onMessage.addListener((message: unknown) => {
        const decoded = decode(StreamRequest, STREAM_PORT, message);
        if (!decoded) return post({ type: "result", result: { status: "failed" } });
        options.translate(decoded.blocks, sender, (index, text, final) => post({ type: "block", index, text, final })).then(
          (result) => post({ type: "result", result }),
          (error) => post({ type: "result", result: { status: "failed", error: String(error) } }),
        );
      });
    },
  };
}
