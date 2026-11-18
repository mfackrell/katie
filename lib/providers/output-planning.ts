import type { ChatGenerateParams } from "./types";
import { getModelPrice } from "@/lib/standalone-accounting/pricing";

/**
 * A Best Answer long-form request reserves room for both visible deliverables
 * and hidden reasoning. The immutable accounting transport quotes this exact
 * allowance before transmission; it never grants additional spending authority.
 * Routine requests and Best Value retain their existing preparation behavior.
 */
export function planBestAnswerOutputTokens(
  params: ChatGenerateParams, model: string
): number | undefined {
  if (params.routingMode !== "best_answer") return undefined;
  const price = getModelPrice("openai", model);
  if (!price || !price.maxOutputTokens || !price.maxContextTokens) return undefined;
  const request = params.user ?? "";
  const attachedLength = (params.attachments ?? []).reduce(
    (n, file) => n + Math.min(file.extractedText?.length ?? 0, 200_000), 0);
  const numberedSections = (request.match(/(?:^|\n)\s*(?:\d{1,2}[.)]\s+|[-*]\s+)/g) ?? []).length;
  const substantiveTask = /\b(?:analy[sz]e|analysis|assess|evaluate|review|critique|audit|fact.check|validate|qualification|due diligence|strategic|compare|recommendation)\b/i.test(request);
  const substantialScope = /\b(?:comprehensive|in.depth|extensive|detailed|deep|thorough|all\s+\d+|each\s+of|full\s+report|line.by.line)\b/i.test(request);
  const sourceLength = request.length + attachedLength;
  if (!substantiveTask || !(numberedSections >= 6 || sourceLength >= 2_500 || substantialScope)) return undefined;

  // Scope is based on source workload, not a universal response ceiling.
  const sections = Math.min(40, Math.max(3, numberedSections, Math.ceil(sourceLength / 1_500)));
  const visibleAllowance = 1_200 + sections * 400;
  const reasoningAllowance = Math.ceil(visibleAllowance * (/\bpro(?:-|$)/i.test(model) ? 1.6 : 1.1)) + 2_048;
  const proposed = Math.ceil((visibleAllowance + reasoningAllowance) / 512) * 512;
  return Math.min(proposed, price.maxOutputTokens, price.maxContextTokens);
}
