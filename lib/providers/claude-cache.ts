/** Only cache an explicitly supplied, exact prefix; never infer stability from prompt text. */
export function claudeCachedSystem(system: string, prefix?: string) {
  if (!prefix || !system.startsWith(prefix)) return system;
  return [
    { type: "text" as const, text: prefix, cache_control: { type: "ephemeral" as const, ttl: "5m" as const } },
    ...(system.length > prefix.length ? [{ type: "text" as const, text: system.slice(prefix.length) }] : [])
  ];
}

export function claudeInputUsage(usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) {
  const uncached = usage?.input_tokens;
  const read = usage?.cache_read_input_tokens;
  const written = usage?.cache_creation_input_tokens;
  return {
    inputTokens: [uncached, read, written].some(value => typeof value === "number")
      ? (uncached ?? 0) + (read ?? 0) + (written ?? 0) : undefined,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: written,
  };
}
