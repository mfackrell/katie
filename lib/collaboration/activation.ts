import { getCollaborationConfig } from "@/lib/collaboration/config";
import type { RequestIntent, RequestComplexity } from "@/lib/router/model-intent";

const EXPLICIT_COLLABORATION_PATTERN =
  /\b(collaborat(?:e|ion)|work together|ask another model|ask other models|second opinion|council|multi[- ]model|consult another|consult other|use multiple models|models work together|deep review|adversarial review)\b/i;

const COMPLEX_INTENTS = new Set<RequestIntent>([
  "code-review",
  "technical-debugging",
  "architecture-review",
  "code-generation",
  "marketing-analysis",
  "web-search",
  "multimodal-reasoning",
]);

export function shouldUseAdaptiveCollaboration(input: {
  message: string;
  intent?: RequestIntent | null;
  complexity?: RequestComplexity | null;
  hasManualOverride?: boolean;
  hasVideoInput?: boolean;
}): boolean {
  if (!getCollaborationConfig().enabled) {
    return false;
  }

  if (EXPLICIT_COLLABORATION_PATTERN.test(input.message)) {
    return true;
  }

  if (input.hasManualOverride) {
    return false;
  }

  if (input.intent === "image-generation") {
    return false;
  }

  if (input.complexity === "high") {
    return true;
  }

  if (
    input.complexity === "medium" &&
    input.intent &&
    COMPLEX_INTENTS.has(input.intent)
  ) {
    return true;
  }

  if (
    input.intent &&
    COMPLEX_INTENTS.has(input.intent) &&
    input.message.trim().length >= 500
  ) {
    return true;
  }

  return false;
}

export function isExplicitCollaborationRequest(message: string): boolean {
  return EXPLICIT_COLLABORATION_PATTERN.test(message);
}
