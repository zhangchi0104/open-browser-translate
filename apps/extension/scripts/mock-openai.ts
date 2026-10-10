#!/usr/bin/env bun
/**
 * A tiny OpenAI-compatible API for trying the extension without a model provider, through a custom
 * connection; docs/safari.md uses it to check the Safari build.
 *
 *   bun apps/extension/scripts/mock-openai.ts    # listens on 0.0.0.0:8787
 *   PORT=9000 STREAM_DELAY_MS=5 bun apps/extension/scripts/mock-openai.ts
 *
 * Extension settings: API URL http://127.0.0.1:8787/v1, model "mock-translator", any (or no) key.
 *
 * Routes (each also without the /v1 prefix):
 *   GET  /v1/models            model list
 *   POST /v1/chat/completions  JSON or SSE (stream: true), what @effect/ai-openai-compat sends
 *
 * Answers:
 *   - translation (user message is {"blocks":[{"id":0,"text":"..."}], ...}): each block becomes
 *     "[译] <text>", as JSON {"translations":[...],"terms":[]}, streamed or not;
 *   - response_format json_schema: a minimal instance of the schema; any object whose properties
 *     are all numbers (a decision's "probabilities") gets 0.9 on its first option, the rest shared;
 *   - anything else: a short plain-text reply.
 *
 * Env: PORT (8787), MARKER ("[译] "), STREAM_DELAY_MS (15), STREAM_CHUNK (16 chars), LATENCY_MS (0),
 * API_KEY (unset: any or no key works; set: other keys get 401, for checking 「测试连接」).
 */

const PORT = Number(process.env.PORT ?? 8787);
const MARKER = process.env.MARKER ?? "[译] ";
const STREAM_DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 15);
const STREAM_CHUNK = Math.max(1, Number(process.env.STREAM_CHUNK ?? 16));
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
const API_KEY = process.env.API_KEY;
const MODELS = ["mock-translator", "mock-analyzer"];

type Json = any;

// ---------------------------------------------------------------------------- logging

const color = (code: number, text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const time = () => new Date().toISOString().slice(11, 23);
const log = (line: string) => console.log(`${color(90, time())} ${line}`);
const loud = (line: string) => console.log(`${color(90, time())} ${color(41, " !!! UNRECOGNISED ")} ${color(31, line)}`);
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/\s+/g, " ");

// ---------------------------------------------------------------------------- CORS

function cors(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers")
      ?? "authorization, content-type, accept, openai-organization, openai-project, x-requested-with",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
  };
}

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(request), "Content-Type": "application/json" } });

const error = (request: Request, status: number, message: string) =>
  json(request, { error: { message, type: "invalid_request_error", code: null } }, status);

// ---------------------------------------------------------------------------- JSON Schema → minimal instance

function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith("#/")) { loud(`schema $ref outside the document: ${ref}`); return {}; }
  return ref.slice(2).split("/").reduce((node: Json, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root) ?? {};
}

function instance(schema: Json, root: Json, key = "", depth = 0): Json {
  if (depth > 40) return null;
  if (schema === true || schema === undefined || schema === null) return null;
  if (schema.$ref) return instance({ ...resolveRef(root, schema.$ref), ...omit(schema, "$ref") }, root, key, depth + 1);
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    return instance(schema.allOf.reduce((merged: Json, part: Json) => mergeSchemas(merged, part.$ref ? resolveRef(root, part.$ref) : part), omit(schema, "allOf")), root, key, depth + 1);
  }
  for (const union of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[union])) {
      const options = schema[union];
      const pick = options.find((option: Json) => option?.type !== "null") ?? options[0];
      return instance({ ...omit(schema, union), ...pick }, root, key, depth + 1);
    }
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((t: string) => t !== "null") ?? schema.type[0]) : schema.type;
  switch (type ?? (schema.properties ? "object" : schema.items ? "array" : undefined)) {
    case "object": {
      const properties: Record<string, Json> = schema.properties ?? {};
      const names = Object.keys(properties);
      const resolved = names.map((name) => properties[name]?.$ref ? resolveRef(root, properties[name].$ref) : properties[name]);
      // A decision's option weights: an object of numbers only. Favour the first option confidently.
      if (names.length > 0 && resolved.every((p) => isNumberSchema(p))) {
        const rest = names.length > 1 ? 0.1 / (names.length - 1) : 0;
        return Object.fromEntries(names.map((name, index) => [name, index === 0 ? (names.length > 1 ? 0.9 : 1) : rest]));
      }
      return Object.fromEntries(names.map((name) => [name, instance(properties[name], root, name, depth + 1)]));
    }
    case "array": {
      const count = Math.max(0, schema.minItems ?? 0);
      const items = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
      const out = items.map((item: Json, index: number) => instance(item, root, `${key}[${index}]`, depth + 1));
      while (out.length < count) out.push(instance(schema.items ?? {}, root, `${key}[]`, depth + 1));
      return out;
    }
    case "string": {
      let text = `mock ${key || "text"}`;
      if (schema.format === "date-time") text = new Date().toISOString();
      if (schema.format === "date") text = new Date().toISOString().slice(0, 10);
      if (schema.format === "uri") text = "https://example.com/";
      if (schema.minLength && text.length < schema.minLength) text = text.padEnd(schema.minLength, "x");
      if (schema.maxLength !== undefined) text = text.slice(0, schema.maxLength);
      return text;
    }
    case "integer":
    case "number": {
      let value = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
      if (schema.maximum !== undefined) value = Math.min(value, schema.maximum);
      return type === "integer" ? Math.ceil(value) : value;
    }
    case "boolean": return false;
    case "null": return null;
    default:
      if (Object.keys(schema).length > 0 && !schema.description) loud(`schema node not understood at "${key}": ${clip(JSON.stringify(schema), 200)}`);
      return null;
  }
}

function isNumberSchema(schema: Json): boolean {
  if (!schema || typeof schema !== "object") return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((t: string) => t === "number" || t === "integer")) return true;
  const union = schema.anyOf ?? schema.oneOf;
  return Array.isArray(union) && union.some(isNumberSchema);
}

function mergeSchemas(a: Json, b: Json): Json {
  return { ...a, ...b, properties: { ...a.properties, ...b.properties }, required: [...(a.required ?? []), ...(b.required ?? [])] };
}

function omit(object: Json, key: string): Json {
  const { [key]: _, ...rest } = object;
  return rest;
}

// ---------------------------------------------------------------------------- request understanding

function textOf(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
  return "";
}

function parseJson(text: string): Json {
  try { return JSON.parse(text); } catch { return undefined; }
}

interface Plan {
  kind: "translation" | "structured" | "text";
  summary: string;
  content: string;
}

function plan(body: Json): Plan {
  const messages: Json[] = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const user = [...messages].reverse().find((m) => m.role === "user");
  const userText = textOf(user?.content);
  const input = parseJson(userText);
  const format = body.response_format;
  const schema = format?.type === "json_schema" ? format.json_schema?.schema : undefined;

  for (const key of Object.keys(body)) {
    if (!KNOWN_BODY_KEYS.has(key)) loud(`request body key "${key}" = ${clip(JSON.stringify(body[key]), 120)}`);
  }
  if (body.tools?.length) loud(`request has ${body.tools.length} tools (mock never calls tools)`);
  if (format && !["json_schema", "json_object", "text"].includes(format.type)) loud(`response_format.type "${format.type}"`);

  // Translation: the user message is {"blocks":[{id,text}], "context"?}, with or without a schema.
  const blocks = input && Array.isArray(input.blocks) && input.blocks.every((b: Json) => typeof b?.id === "number" && typeof b?.text === "string")
    ? input.blocks as { id: number; text: string }[]
    : undefined;
  if (blocks) {
    const language = /Translate every supplied block into ([^.]+)\./.exec(system)?.[1] ?? "?";
    const value = {
      translations: blocks.map(({ id, text }) => ({ id, text: `${MARKER}${text}` })),
      terms: [] as { source: string; target: string }[],
    };
    if (schema && !(schema.properties?.translations && schema.properties?.terms)) {
      loud(`translation-shaped input but schema has keys [${Object.keys(schema.properties ?? {})}]`);
    }
    const first = blocks[0] ? ` first="${clip(blocks[0].text, 40)}"` : "";
    return {
      kind: "translation",
      summary: `translate ${blocks.length} block(s) → ${language}${input.context ? " (with context)" : ""}${first}`,
      content: JSON.stringify(value),
    };
  }

  if (schema) {
    const value = instance(schema, schema);
    const decisions = input?.decisions && typeof input.decisions === "object" ? Object.keys(input.decisions) : undefined;
    const summary = decisions
      ? `decisions [${decisions.slice(0, 8).join(", ")}${decisions.length > 8 ? `, … ${decisions.length} total` : ""}] → ${clip(Object.entries(value).slice(0, 3).map(([k, v]: [string, Json]) => `${k}:${firstKey(v?.probabilities)}`).join(" "), 120)}`
      : `structured "${format.json_schema?.name}" keys [${Object.keys(schema.properties ?? {}).join(", ")}]`;
    if (!decisions) loud(`structured output not recognised as a decision or translation; answered with a minimal instance of "${format.json_schema?.name}"`);
    return { kind: "structured", summary, content: JSON.stringify(value) };
  }

  if (format?.type === "json_object") {
    loud("response_format json_object without a schema; answering {}");
    return { kind: "structured", summary: "json_object", content: "{}" };
  }

  loud(`plain chat request, user="${clip(userText, 100)}"`);
  return { kind: "text", summary: `chat "${clip(userText, 60)}"`, content: `Mock reply to: ${clip(userText, 200)}` };
}

const firstKey = (object: Json) => (object && typeof object === "object" ? Object.keys(object)[0] : "?");

const KNOWN_BODY_KEYS = new Set([
  "model", "messages", "stream", "stream_options", "response_format", "temperature", "top_p", "max_tokens",
  "max_completion_tokens", "reasoning_effort", "tools", "tool_choice", "parallel_tool_calls", "user", "seed",
  "service_tier", "reasoning", "store", "metadata", "verbosity",
]);

// ---------------------------------------------------------------------------- responses

let counter = 0;
const usageOf = (body: Json, content: string) => {
  const prompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const completion = Math.ceil(content.length / 4);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
};

function completion(request: Request, body: Json, model: string, content: string) {
  return json(request, {
    id: `chatcmpl-mock-${++counter}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop", logprobs: null }],
    usage: usageOf(body, content),
  });
}

function streamCompletion(request: Request, body: Json, model: string, content: string) {
  const id = `chatcmpl-mock-${++counter}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (choices: Json[], extra: Json = {}) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`;
  const encoder = new TextEncoder();
  const sleep = (ms: number) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string) => { if (!cancelled) controller.enqueue(encoder.encode(text)); };
      send(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
      const chars = Array.from(content); // by code point, so no chunk splits a surrogate pair
      for (let offset = 0; offset < chars.length && !cancelled; offset += STREAM_CHUNK) {
        await sleep(STREAM_DELAY_MS);
        send(chunk([{ index: 0, delta: { content: chars.slice(offset, offset + STREAM_CHUNK).join("") }, finish_reason: null }]));
      }
      send(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      if (body.stream_options?.include_usage) send(chunk([], { usage: usageOf(body, content) }));
      send("data: [DONE]\n\n");
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
      log(color(33, `stream ${id} cancelled by client`));
    },
  });
  return new Response(stream, {
    headers: { ...cors(request), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

// ---------------------------------------------------------------------------- server

// The workspace has no Bun type definitions; this is the part of Bun's API the server uses.
declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    idleTimeout: number;
    fetch(request: Request): Promise<Response>;
    error(err: Error): Response;
  }): { port: number };
  sleep(ms: number): Promise<void>;
};

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "").replace(/\/+$/, "") || "/";
    const method = request.method;
    const auth = request.headers.get("authorization") ? "key" : "no key";

    if (method === "OPTIONS") {
      log(`${color(36, "OPTIONS")} ${url.pathname} preflight (origin ${request.headers.get("origin") ?? "-"}, headers ${request.headers.get("access-control-request-headers") ?? "-"})`);
      return new Response(null, { status: 204, headers: cors(request) });
    }

    if (LATENCY_MS > 0) await Bun.sleep(LATENCY_MS);

    if (API_KEY && request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
      log(`${color(31, method)} ${url.pathname} (${auth}) → 401`);
      return json(request, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
    }

    if (method === "GET" && path === "/models") {
      log(`${color(32, "GET")} ${url.pathname} (${auth}) → ${MODELS.length} models`);
      const created = Math.floor(Date.now() / 1000);
      return json(request, { object: "list", data: MODELS.map((id, index) => ({ id, object: "model", created: created - index, owned_by: "mock" })) });
    }

    if (method === "GET" && MODELS.some((id) => path === `/models/${id}`)) {
      log(`${color(32, "GET")} ${url.pathname}`);
      return json(request, { id: path.slice("/models/".length), object: "model", created: Math.floor(Date.now() / 1000), owned_by: "mock" });
    }

    if (method === "POST" && path === "/chat/completions") {
      const body = parseJson(await request.text());
      if (!body || typeof body !== "object") {
        loud(`POST ${url.pathname} with a body that isn't JSON`);
        return error(request, 400, "Body must be JSON");
      }
      const model = typeof body.model === "string" ? body.model : "mock-translator";
      if (!MODELS.includes(model)) log(color(33, `note: unknown model "${model}", answering anyway`));
      const streaming = body.stream === true;
      const answer = plan(body);
      log(`${color(32, "POST")} ${url.pathname} model=${model} stream=${streaming} (${auth}) [${answer.kind}] ${answer.summary}`);
      return streaming ? streamCompletion(request, body, model, answer.content) : completion(request, body, model, answer.content);
    }

    if (method === "GET" && path === "/") {
      log(`GET ${url.pathname} (health)`);
      return new Response(`mock OpenAI-compatible API; use ${url.origin}/v1\n`, { headers: { ...cors(request), "Content-Type": "text/plain" } });
    }

    const body = method === "POST" ? clip(await request.text(), 300) : "";
    loud(`${method} ${url.pathname}${url.search} ${body}`);
    return error(request, 404, `mock-openai: no route for ${method} ${url.pathname}`);
  },
  error(err) {
    loud(`server error: ${err?.stack ?? err}`);
    return new Response(JSON.stringify({ error: { message: String(err) } }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  },
});

log(`mock OpenAI-compatible API on http://0.0.0.0:${server.port}/v1 (try http://127.0.0.1:${server.port}/v1), models: ${MODELS.join(", ")}`);
