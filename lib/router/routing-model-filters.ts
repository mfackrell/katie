const BLOCKED_MODEL_PATTERNS = [/^gpt-5\.4-pro(?:-|$)/i];

export function isBlockedRoutingModel(modelId: string): boolean {
  return BLOCKED_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}
