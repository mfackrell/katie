/**
 * Deterministic, best-effort delivery checks for unambiguous user requests.
 * This does not judge subjective answer quality or invoke another model.
 * Private workflow checkpoints retain only categorical metadata, not user text.
 */
export type RoutingDeliveryAudit = {
  version: "routing-delivery-v1";
  status: "pass" | "fail" | "unverified";
  reason: "written_deliverable_missing" | "image_deliverable_missing" | "compound_deliverable_incomplete" | "explicit_output_present" | "objective_not_deterministically_verifiable";
  requestedText: boolean;
  requestedImage: boolean;
  producedText: boolean;
  producedImage: boolean;
};

export function auditRoutingDelivery(input: {
  userMessage: string;
  selectedIntent: string | null | undefined;
  answer: string;
  imageCount: number;
}): RoutingDeliveryAudit {
  const message = input.userMessage;
  const writeCommand = /\b(?:write|rewrite|draft|revise|polish|rephrase|compose)\s+(?:(?:me|us)\s+)?(?:.{0,90}?)\b(?:bio|profile|email|letter|post|caption|description|message|summary|paragraph|script|resume|text|copy)\b/i.test(message);
  const imageCommand = /\b(?:generate|create|draw|render|design|make)\s+(?:(?:me|us)\s+)?(?:.{0,80}?)\b(?:image|photo|picture|portrait|illustration|artwork|graphic)\b/i.test(message);
  const requestedText = writeCommand;
  const requestedImage = imageCommand;
  const substantiveAnswer = input.answer.trim();
  const producedText = Boolean(substantiveAnswer) &&
    !/^\[(?:image generated|video generated|document generated)\]\s*$/i.test(substantiveAnswer);
  const producedImage = input.imageCount > 0;
  const base = { version: "routing-delivery-v1" as const, requestedText, requestedImage, producedText, producedImage };
  if (!requestedText && !requestedImage) return { ...base, status: "unverified", reason: "objective_not_deterministically_verifiable" };
  if (requestedText && requestedImage && (!producedText || !producedImage)) {
    return { ...base, status: "fail", reason: "compound_deliverable_incomplete" };
  }
  if (requestedText && !producedText) return { ...base, status: "fail", reason: "written_deliverable_missing" };
  if (requestedImage && !producedImage) return { ...base, status: "fail", reason: "image_deliverable_missing" };
  return { ...base, status: "pass", reason: "explicit_output_present" };
}
