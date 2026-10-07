import { OpenAiClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Option, Redactable, type Redacted, Schema } from "effect";
import { AiError, DecisionModel } from "effect/unstable/ai";
import type * as Decision from "effect/unstable/ai/Decision";
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { OPENAI_API_URL } from "./openai-models";
import { normalizeDistribution } from "./distribution";

// OpenAI's Decisions API (public beta), `POST /v1/decisions`:
// https://developers.openai.com/api/docs/guides/decisions
// The request and response shapes follow openai-node's `src/resources/decisions.ts`.

type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string }[] };

/** A `DecisionModel` decision as a Decisions API question named `name`. */
export function toQuestion(name: string, decision: Decision.Any): Question {
  switch (decision._tag) {
    case "Classify":
      return { type: "choice", name, instructions: decision.instructions, choices: Object.entries(decision.criteria).map(([value, description]) => ({ value, description })) };
    case "Rate":
      return { type: "score", name, instructions: decision.instructions, levels: decision.criteria.map((label) => ({ label })) };
    // A predicate has no options to describe, so what true and false mean goes into its instructions.
    case "Probability":
      return { type: "predicate", name, instructions: `${decision.instructions}\nTrue: ${decision.criteria.true}\nFalse: ${decision.criteria.false}` };
  }
}

const name = Schema.NullOr(Schema.String);
const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("predicate"), name, probability: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    name,
    choice: Schema.Union([Schema.String, Schema.Boolean]),
    confidence: Schema.Number,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.Union([Schema.String, Schema.Boolean]), probability: Schema.Number })),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    name,
    score: Schema.Number,
    confidence: Schema.Number,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.Number, label: Schema.String, probability: Schema.Number })),
  }),
  // The API may decline a question without saying why.
  Schema.Struct({ type: Schema.Literal("refusal"), name }),
]);
const DecisionsResponse = Schema.Struct({
  answers: Schema.Array(Answer),
  usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })),
});
const decodeResponse = HttpClientResponse.schemaBodyJson(DecisionsResponse);
const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    message: Schema.optional(Schema.NullOr(Schema.String)),
    type: Schema.optional(Schema.NullOr(Schema.String)),
    code: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

const aiError = (reason: AiError.AiErrorReason) => AiError.make({ module: "OpenAIDecisions", method: "decide", reason });

// Mirrors the error mapping in @effect/ai-openai-compat's internal/errors.ts, which isn't exported.
const requestDetails = (request: HttpClientRequest.HttpClientRequest) => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  hash: Option.getOrUndefined(request.hash),
  headers: Redactable.redact(request.headers) as Record<string, string>,
});

const mapHttpClientError = (error: HttpClientError.HttpClientError) => Effect.gen(function* () {
  const source = error.reason;
  if (source._tag !== "StatusCodeError") {
    return yield* source._tag === "DecodeError" || source._tag === "EmptyBodyError"
      ? aiError(new AiError.InvalidOutputError({ description: source.description ?? "Failed to read the Decisions API response" }))
      : aiError(new AiError.NetworkError({ reason: source._tag, description: source.description, request: requestDetails(source.request) }));
  }
  const { request, response } = source;
  const body = yield* response.text.pipe(Effect.orElseSucceed(() => source.description));
  const details = Option.getOrUndefined(decodeErrorBody(body ?? ""))?.error;
  const description = AiError.buildErrorDescription({
    status: response.status,
    method: request.method,
    url: request.url,
    body,
    message: details?.message ?? undefined,
    errorCode: details?.code,
    errorType: details?.type,
    requestId: response.headers["x-request-id"],
  });
  const http = { request: requestDetails(request), response: { status: response.status, headers: Redactable.redact(response.headers) as Record<string, string> }, body };
  return yield* aiError(AiError.reasonFromHttpStatus({ status: response.status, description, http }));
});

/** Turns a Decisions API answer into the `DecisionModel` answer for `decision`. */
export function fromAnswer(key: string, decision: Decision.Any, answer: typeof Answer.Type | undefined): DecisionModel.ProviderAnswer | AiError.AiError {
  const invalid = (description: string) => aiError(new AiError.InvalidOutputError({ description }));
  if (!answer) return invalid(`The Decisions API returned no answer for decision "${key}"`);
  if (answer.type === "refusal") return aiError(new AiError.ContentPolicyError({ description: `The Decisions API declined decision "${key}"` }));
  switch (decision._tag) {
    case "Classify":
      if (answer.type !== "choice") break;
      return {
        _tag: "Classify",
        label: String(answer.choice),
        // Its probabilities are rounded like Jev's, so they can miss 1 by a little.
        probabilities: normalizeDistribution(Object.keys(decision.criteria), Object.fromEntries(answer.probabilities.map(({ value, probability }) => [String(value), probability]))),
        confidence: answer.confidence,
      };
    case "Rate":
      if (answer.type !== "score") break;
      return {
        _tag: "Rate",
        rating: answer.score,
        probabilities: normalizeDistribution(decision.criteria, Object.fromEntries(answer.probabilities.map(({ label, probability }) => [label, probability]))),
        confidence: answer.confidence,
      };
    case "Probability":
      if (answer.type !== "predicate") break;
      return { _tag: "Probability", probability: answer.probability };
  }
  return invalid(`The Decisions API answered decision "${key}" with a ${answer.type} answer`);
}

const make = (model: string) => Effect.gen(function* () {
  // OpenAI's client carries the key and base URL but leaves status checks to its callers.
  const client = (yield* OpenAiClient.OpenAiClient).client.pipe(HttpClient.filterStatusOk);
  return yield* DecisionModel.make({
    decide: ({ state, decisions }) => Effect.gen(function* () {
      const keys = Object.keys(decisions);
      const request = HttpClientRequest.post("/decisions").pipe(HttpClientRequest.bodyJsonUnsafe({
        model,
        input: typeof state === "string" ? state : JSON.stringify(state),
        questions: keys.map((key) => toQuestion(key, decisions[key]!)),
      }));
      const response = yield* client.execute(request).pipe(
        Effect.flatMap(decodeResponse),
        Effect.catchTags({
          HttpClientError: mapHttpClientError,
          SchemaError: (error) => Effect.fail(aiError(AiError.InvalidOutputError.fromSchemaError(error))),
        }),
      );
      const byName = new Map(response.answers.map((answer) => [answer.name, answer]));
      const answers: Record<string, DecisionModel.ProviderAnswer> = {};
      for (const key of keys) {
        const answer = fromAnswer(key, decisions[key]!, byName.get(key));
        if (AiError.isAiError(answer)) return yield* Effect.fail(answer);
        answers[key] = answer;
      }
      return { answers, usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens } };
    }),
  });
});

/** `DecisionModel` on OpenAI's Decisions API with an API key. */
export function openAIDecisionLayer(options: { apiKey: Redacted.Redacted<string>; model: string }) {
  return Layer.effect(DecisionModel.DecisionModel, make(options.model)).pipe(
    Layer.provide(OpenAiClient.layer({ apiKey: options.apiKey, apiUrl: OPENAI_API_URL })),
    Layer.provide(FetchHttpClient.layer),
  );
}
