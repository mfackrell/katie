import { createHash } from "node:crypto";

/** Stable, opaque server-owned scope. Never include prompt text or a request ID. */
export function conversationCacheKey(actorId: string, chatId: string): string {
  return "katie:v1:" + createHash("sha256").update(JSON.stringify([actorId, chatId])).digest("hex");
}

/** Explicit allowlist: unknown models keep provider defaults rather than risk rejection.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * Settings are opt-in via conversation scope; unrelated workers remain unchanged.
 */
export function openAiCacheSettings(model: string, key?: string, endpoint: "responses" | "chat-completions" = "responses") {
  if (!key) return {};
  const modern = /^gpt-(?:5\.[6-9]|6(?:\.[0-9]+)?)(?:-|$)/.test(model);
  const extended = /^(?:gpt-5\.5(?:-pro)?|gpt-5\.4|gpt-5\.2|gpt-5\.1(?:-codex-max|-codex-mini|-codex|-chat-latest)?|gpt-5(?:-codex)?|gpt-4\.1)(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  const ordinary = /^(?:gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?|gpt-5(?:[.-]|$)|o[1-4](?:-|$))/.test(model);
  if (!modern && !extended && !ordinary) return {};
  return {
    prompt_cache_key: key,
    ...(modern
      ? (endpoint === "responses" ? { prompt_cache_options: { ttl: "30m" as const } } : {})
      : extended ? { prompt_cache_retention: "24h" as const } : {}),
  };
}
