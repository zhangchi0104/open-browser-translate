// Mocked model responses: OpenAI-compatible decisions and Chat Completions.
// Answers a mocked OpenAI Chat Completions request made by the OpenAI decision adapter.
export function isDecisionRequest(body: any) {
  return body?.response_format?.json_schema?.name === "decisions";
}

/** `pick` returns the label to put all probability on, given the decision key and the request input. */
export function decisionResponse(body: any, pick: (key: string, input: any, labels: string[]) => string) {
  const { input, decisions } = JSON.parse(body.messages.at(-1).content);
  const value = Object.fromEntries(Object.entries(decisions as Record<string, { options: Record<string, string> }>).map(([key, decision]) => {
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
