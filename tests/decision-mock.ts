// Mocked model requests and responses: OpenAI-compatible decisions and Chat Completions.
import { Schema } from "effect";

/** The parts of a Chat Completions request the tests look at; other fields are dropped. */
const ChatRequest = Schema.Struct({
  model: Schema.String,
  stream: Schema.optional(Schema.Boolean),
  messages: Schema.Array(Schema.Struct({ content: Schema.String })),
  response_format: Schema.optional(Schema.Struct({ json_schema: Schema.optional(Schema.Struct({ name: Schema.String })) })),
  reasoning_effort: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.String),
  providerOptions: Schema.optional(Schema.Unknown),
});
export type ChatRequest = typeof ChatRequest.Type;

const decodeChatRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRequest));
const decodeModel = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ model: Schema.String })));

/** The Chat Completions request a mocked fetch received. */
export const chatRequest = (init?: RequestInit): ChatRequest => decodeChatRequest(String(init?.body));

/** The model any mocked request named. */
export const requestedModel = (init?: RequestInit) => decodeModel(String(init?.body)).model;

/** The JSON the request's last message carries, decoded with `schema`. */
const lastMessage = <A>(body: ChatRequest, schema: Schema.Codec<A>): A =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema))(body.messages.at(-1)!.content);

/** Blocks as content analysis sends them to the model. */
export const blocksIn = (input: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ blocks: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String, tag: Schema.String })) }))(input).blocks;

/** What the translator sends: the blocks to translate and, when there is one, the site's context. */
export const translationInput = (body: ChatRequest) => lastMessage(body, Schema.Struct({
  context: Schema.optional(Schema.Unknown),
  blocks: Schema.Array(Schema.Struct({ id: Schema.Number, text: Schema.String })),
}));

// Answers a mocked OpenAI Chat Completions request made by the OpenAI decision adapter.
export function isDecisionRequest(body: ChatRequest) {
  return body.response_format?.json_schema?.name === "decisions";
}

/** `pick` returns the label to put all probability on, given the decision key and the request input. */
export function decisionResponse(body: ChatRequest, pick: (key: string, input: unknown, labels: string[]) => string) {
  const { input, decisions } = lastMessage(body, Schema.Struct({
    input: Schema.Unknown,
    decisions: Schema.Record(Schema.String, Schema.Struct({ options: Schema.Record(Schema.String, Schema.String) })),
  }));
  const value = Object.fromEntries(Object.entries(decisions).map(([key, decision]) => {
    const labels = Object.keys(decision.options);
    const label = pick(key, input, labels);
    return [key, { probabilities: Object.fromEntries(labels.map((option) => [option, option === label ? 1 : 0])) }];
  }));
  return Response.json({
    id: "test", object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/** A Chat Completions response whose message is `content`. */
export function chatCompletion(model: string, content: string) {
  return Response.json({ id: "test", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
}

/** The same response streamed, `content` arriving a few characters at a time. */
export function chatCompletionStream(model: string, content: string) {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const pieces = content.match(/[\s\S]{1,7}/g) ?? [];
  const body = chunk({ role: "assistant", content: "" }) + pieces.map((piece) => chunk({ content: piece })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
