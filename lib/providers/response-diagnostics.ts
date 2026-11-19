/**
 * Safe metadata-only diagnostics for durable provider accounting evidence.
 * Never store response text, prompts, private reasoning, raw errors or credentials.
 */
export type ProviderOutcomeDiagnostic = {
  providerResponseStatus: string | null;
  providerFinishReason: string | null;
  providerIncompleteReason: string | null;
  reasoningTokens: number | null;
  hasVisibleOutput: boolean;
  streamComplete: boolean;
  normalizedFailureReason: string | null;
  safeProviderErrorCode: string | null;
};
const statuses = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);
const reasons = new Set(["max_output_tokens", "content_filter", "context_length_exceeded"]);
const finishes = new Set(["stop", "length", "content_filter", "tool_calls", "function_call",
  "MAX_TOKENS", "SAFETY", "PROHIBITED_CONTENT", "OTHER", "STOP", "end_turn", "max_tokens"]);
const safeCodes = new Set(["model_not_found", "invalid_request_error", "context_length_exceeded",
  "rate_limit_exceeded", "insufficient_quota", "unsupported_model", "overloaded_error",
  "authentication_error", "permission_error", "server_error"]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const known = (value: unknown, values: Set<string>): string | null =>
  typeof value === "string" && values.has(value) ? value : null;
const nonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function containsVisibleText(root: Record<string, unknown>): boolean {
  if (typeof root.output_text === "string" && root.output_text.trim()) return true;
  const output = Array.isArray(root.output) ? root.output : [];
  if (output.some(item => typeof record(item).result === "string" && Boolean((record(item).result as string).trim()))) return true;
  if (output.some(item => Array.isArray(record(item).content) &&
    (record(item).content as unknown[]).some(part => typeof record(part).text === "string" &&
      Boolean((record(part).text as string).trim())))) return true;
  const content = Array.isArray(root.content) ? root.content : [];
  if (content.some(part => typeof record(part).text === "string" && Boolean((record(part).text as string).trim()))) return true;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  if (choices.some(choice => {
    const c = record(choice); const message = record(c.message);
    return Boolean((typeof message.content === "string" && message.content.trim()) ||
      (typeof record(c.delta).content === "string" && (record(c.delta).content as string).trim()));
  })) return true;
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  return candidates.some(candidate => {
    const parts = record(record(candidate).content).parts;
    return Array.isArray(parts) && parts.some(part => !record(part).thought &&
      typeof record(part).text === "string" && Boolean((record(part).text as string).trim()));
  });
}
export function summarizeProviderOutcome(
  body: string, provider: string, endpoint: string, streaming: boolean, httpStatus: number
): ProviderOutcomeDiagnostic {
  // Provider and endpoint are deliberately not persisted with arbitrary
  // response text; the surrounding accounting receipt already binds both.
  void endpoint;
  let terminal: Record<string, unknown> = {};
  let sawDone = !streaming, sawText = false, sawAnthropicFinalDelta = false;
  try {
    if (!streaming) terminal = record(JSON.parse(body));
    else for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim()).join("\n");
      // [DONE] is an OpenAI/xAI SSE marker, not an Anthropic messages terminal.
      if (data === "[DONE]") { if (provider !== "anthropic") sawDone = true; continue; }
      if (!data) continue;
      const event = record(JSON.parse(data));
      if (containsVisibleText(event)) sawText = true;
      const kind = event.type;
      if (kind === "response.completed" || kind === "response.incomplete" || kind === "response.failed") {
        terminal = record(event.response ?? event); sawDone = true;
      } else if (kind === "message_delta") {
        // Anthropic's final delta includes stop reason/usage, but isn't final.
        terminal = event;
        sawAnthropicFinalDelta = typeof record(event.delta).stop_reason === "string";
      } else if (kind === "message_stop") {
        if (provider !== "anthropic" || sawAnthropicFinalDelta) sawDone = true;
        if (!Object.keys(terminal).length) terminal = event;
      } else if (Array.isArray(event.choices) || event.candidates || event.usageMetadata) terminal = event;
    }
  } catch { if (streaming) sawDone = false; /* malformed streams cannot prove completion */ }
  const status = known(terminal.status, statuses);
  const incomplete = known(record(terminal.incomplete_details).reason, reasons);
  const choice = (Array.isArray(terminal.choices) ? terminal.choices : [])[0];
  const candidate = (Array.isArray(terminal.candidates) ? terminal.candidates : [])[0];
  const finish = known(record(choice).finish_reason ?? record(candidate).finishReason ??
    terminal.stop_reason ?? record(terminal.delta).stop_reason, finishes);
  const usage = record(terminal.usage);
  const reasoning = nonnegative(record(usage.output_tokens_details).reasoning_tokens ??
    record(usage.completion_tokens_details).reasoning_tokens ??
    record(usage.output_tokens_details).thinking_tokens ??
    usage.thoughtsTokenCount);
  const rootError = record(terminal.error);
  const errorCode = known(rootError.code ?? rootError.type, safeCodes);
  const visible = sawText || containsVisibleText(terminal);
  let failure: string | null = null;
  if (httpStatus === 408 || httpStatus === 504) failure = "TIMEOUT";
  else if (httpStatus === 429) failure = "PROVIDER_RATE_LIMIT";
  else if (httpStatus >= 500) failure = "PROVIDER_SERVICE_FAILURE";
  else if (httpStatus >= 400) failure = ["model_not_found", "unsupported_model"].includes(errorCode ?? "") ?
    "UNSUPPORTED_MODEL" : errorCode === "context_length_exceeded" ? "CONTEXT_CAPACITY_EXHAUSTED" : "PROVIDER_REJECTION";
  else if (status === "incomplete" && incomplete === "max_output_tokens" ||
    finish === "MAX_TOKENS" || finish === "max_tokens" || finish === "length") failure = "OUTPUT_TOKEN_EXHAUSTED";
  else if (incomplete === "context_length_exceeded") failure = "CONTEXT_CAPACITY_EXHAUSTED";
  else if (incomplete === "content_filter" || finish === "content_filter" ||
    finish === "SAFETY" || finish === "PROHIBITED_CONTENT") failure = "PROVIDER_REFUSAL";
  else if (status === "failed") failure = "PROVIDER_FAILURE";
  else if (status === "completed" && Array.isArray(terminal.output) &&
    terminal.output.some(part => Array.isArray(record(part).content) &&
      (record(part).content as unknown[]).some(content => record(content).type === "refusal"))) failure = "PROVIDER_REFUSAL";
  else if (status === "completed" && !visible) failure = "NO_VISIBLE_OUTPUT";
  return {providerResponseStatus: status, providerFinishReason: finish,
    providerIncompleteReason: incomplete, reasoningTokens: reasoning,
    hasVisibleOutput: visible, streamComplete: sawDone,
    normalizedFailureReason: failure, safeProviderErrorCode: errorCode};
}
