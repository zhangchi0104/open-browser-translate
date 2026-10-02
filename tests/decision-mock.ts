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
