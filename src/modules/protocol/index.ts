import { Result, Schema } from "effect";
import type { ChatGPTModel } from "../ai/chatgpt-auth";
import type { Purpose } from "../ai/models";
import type { PageAnalysisResult } from "../content-analyzer/page-analysis";
import type { TranslationPlan } from "../content-analyzer/page-plan";
import type { TranslationBatchResult } from "../translator/translate-batch";

// Everything the page, the options page and the background say to each other. Requests are
// decoded against these schemas, limits included, before a handler sees them; replies are
// typed per request. Pages talk through `createClient`, the background answers through
// `createDispatcher`, and both take the browser's runtime as an adapter so tests can connect
// them directly.

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

const request = <const T extends string, const F extends Schema.Struct.Fields = {}>(type: T, fields?: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...(fields ?? {}) as F });

/** Every request a page can send with `runtime.sendMessage`, by `type`. */
export const Requests = {
  "open-settings": request("open-settings"),
  "debug-log": request("debug-log", { entry: PageLog }),
  "debug-log-clear": request("debug-log-clear"),
  "traces-clear": request("traces-clear"),
  "cache-stats": request("cache-stats"),
  "cache-clear": request("cache-clear"),
  "chatgpt-sign-in": request("chatgpt-sign-in"),
  "chatgpt-sign-out": request("chatgpt-sign-out"),
  "chatgpt-models": request("chatgpt-models"),
  /** `apiKey` is the key being edited on the options page; the saved one otherwise. */
  "openai-models": request("openai-models", { apiKey: Schema.optional(Schema.String) }),
  "gateway-models": request("gateway-models"),
  "prepare-translation": request("prepare-translation", { context: PageContext }),
  "analyze-content": request("analyze-content", { mode: Mode, blocks: Batch }),
};
type RequestType = keyof typeof Requests;
export type Request<K extends RequestType = RequestType> = { [T in K]: typeof Requests[T]["Type"] }[K];

type Ok = { status: "ok" };
/** Also the reply to any request that doesn't decode. */
export type Failed = { status: "failed"; error?: string };
export type ModelList = { status: "ok"; models: ChatGPTModel[] } | Failed;
type PrepareResult = { status: "ok"; plan: TranslationPlan } | { status: "not-configured"; purpose: Purpose } | Failed;

/** The reply to each request. */
interface Responses {
  "open-settings": { opened: true };
  "debug-log": void;
  "debug-log-clear": Ok;
  "traces-clear": Ok;
  "cache-stats": { status: "ok"; count: number } | Failed;
  "cache-clear": Ok | Failed;
  "chatgpt-sign-in": { status: "started"; state: string };
  "chatgpt-sign-out": Ok;
  "chatgpt-models": ModelList;
  "openai-models": ModelList | { status: "no-key" };
  "gateway-models": ModelList;
  "prepare-translation": PrepareResult;
  "analyze-content": PageAnalysisResult;
}
export type Response<K extends RequestType> = Responses[K] | Failed;

// Streaming translation: the page opens a port, sends one batch, and receives each block's
// text as it's written (or at once and final when it was cached), then the result.
export const STREAM_PORT = "translate-stream";
const StreamRequest = Schema.Struct({ blocks: Batch });
/** Receives a block's text by index in its batch; `final` once it won't change (cached, or validated). */
export type OnBlock = (index: number, text: string, final: boolean) => void;
type StreamEvent =
  | { type: "block"; index: number; text: string; final: boolean }
  | { type: "result"; result: TranslationBatchResult };

/** The slice of a browser runtime `Port` both sides use. */
export interface Port {
  readonly name: string;
  readonly sender?: Sender;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: any) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}
export interface Sender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: { readonly url?: string; readonly incognito?: boolean };
}

/** The page side, over `browser.runtime` (or a fake in tests). */
export function createClient(runtime: {
  sendMessage(message: unknown): Promise<any>;
  connect(info: { name: string }): Port;
  readonly lastError?: { message?: string } | null;
}) {
  return {
    /** Sends a request; rejects only when the message can't be delivered. */
    request<M extends Request>(message: M): Promise<Response<M["type"]>> {
      return runtime.sendMessage(message);
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
        port.onMessage.addListener((event: StreamEvent) => {
          if (event?.type === "block" && typeof event.index === "number" && typeof event.text === "string") {
            onBlock(event.index, event.text, event.final === true);
          } else if (event?.type === "result" && event.result) finish(event.result);
        });
        port.onDisconnect.addListener(() => finish({ status: "failed", error: `与后台的连接中断：${runtime.lastError?.message ?? "未知原因"}` }));
        port.postMessage({ blocks: blocks.map(({ text, tag }) => ({ text, tag })) });
      });
    },
  };
}

/** Answers one request type; the request has already been decoded. */
export type Handlers = {
  [K in RequestType]: (request: Request<K>, sender: Sender) => Promise<Responses[K]> | Responses[K];
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
  return {
    /**
     * For `runtime.onMessage`. Answers through `sendResponse` and returns true when it will, the
     * form every browser supports (Chrome doesn't deliver a promise a listener returns everywhere).
     */
    onMessage(message: unknown, sender: Sender, sendResponse: (response: unknown) => void): boolean {
      if (!options.trusted(sender)) return false;
      const type = (message as { type?: unknown } | null)?.type;
      if (typeof type !== "string" || !Object.hasOwn(Requests, type)) return false;
      const decoded = decode(Requests[type as RequestType], type, message);
      const handler = options.handlers[type as RequestType] as (request: Request, sender: Sender) => unknown;
      const reply = decoded === undefined ? Promise.resolve({ status: "failed" } satisfies Failed) : Promise.resolve().then(() => handler(decoded, sender));
      reply.then(sendResponse, (error) => sendResponse({ status: "failed", error: String(error) } satisfies Failed));
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
