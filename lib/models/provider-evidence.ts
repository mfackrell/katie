import type { LlmProvider } from "@/lib/providers/types";

/** Audited public, first-party documentation locations; discovery remains account-specific. */
export type OfficialModelSpec = {
  provider: LlmProvider["name"];
  modelId: string;
  documentUrl: string;
  expectedInputPer1m: number;
  expectedOutputPer1m: number;
  reasoningTier: "high" | "medium";
  snapshots?: readonly string[];
};

const specs: readonly OfficialModelSpec[] = [
  { provider: "openai", modelId: "gpt-6.2-astra", documentUrl: "https://developers.openai.com/api/docs/models/gpt-6.2-astra.md", expectedInputPer1m: 8, expectedOutputPer1m: 40, reasoningTier: "high" },
  { provider: "openai", modelId: "gpt-6-astra", documentUrl: "https://developers.openai.com/api/docs/models/gpt-6-astra.md", expectedInputPer1m: 10, expectedOutputPer1m: 50, reasoningTier: "high" },
  { provider: "openai", modelId: "gpt-6.2-sol", documentUrl: "https://developers.openai.com/api/docs/models/gpt-6.2-sol.md", expectedInputPer1m: 2, expectedOutputPer1m: 10, reasoningTier: "high" },
  { provider: "openai", modelId: "gpt-6-sol", documentUrl: "https://developers.openai.com/api/docs/models/gpt-6-sol.md", expectedInputPer1m: 2, expectedOutputPer1m: 10, reasoningTier: "high" },
  { provider: "openai", modelId: "gpt-5.5-pro", documentUrl: "https://developers.openai.com/api/docs/models/gpt-5.5-pro.md", expectedInputPer1m: 30, expectedOutputPer1m: 180, reasoningTier: "high", snapshots: ["gpt-5.5-pro-2026-04-23"] },
  { provider: "openai", modelId: "gpt-5.4-pro", documentUrl: "https://developers.openai.com/api/docs/models/gpt-5.4-pro.md", expectedInputPer1m: 30, expectedOutputPer1m: 180, reasoningTier: "high", snapshots: ["gpt-5.4-pro-2026-03-05"] },
  { provider: "anthropic", modelId: "claude-opus-5-5", documentUrl: "https://platform.claude.com/docs/en/models/opus-5-5/overview.md", expectedInputPer1m: 4, expectedOutputPer1m: 20, reasoningTier: "high" },
  { provider: "anthropic", modelId: "claude-sonnet-5-5", documentUrl: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview.md", expectedInputPer1m: 2, expectedOutputPer1m: 10, reasoningTier: "high" },
  // Fable is only promoted if its own first-party page becomes accessible and passes all checks.
  { provider: "anthropic", modelId: "claude-fable-5-2", documentUrl: "https://platform.claude.com/docs/en/models/fable-5-2/overview.md", expectedInputPer1m: 8, expectedOutputPer1m: 40, reasoningTier: "high" }
];

export type PublishedModelEvidence = {
  documentUrl: string;
  documentedModelId: string;
  inputPer1m: number;
  outputPer1m: number;
  reasoningTier: "high" | "medium";
  supportsText: true;
  supportsVision: true;
  supportsWebSearch: boolean;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  supportedEndpoints: readonly string[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  pricingTier: "standard_base_per_1m";
  hasVariableLongContextRates: boolean;
};

export function officialModelSpec(provider: LlmProvider["name"], modelId: string): OfficialModelSpec | null {
  const normalized = modelId.replace(/^models\//i, "").trim().toLowerCase();
  return specs.find((spec) => spec.provider === provider &&
    (normalized === spec.modelId || spec.snapshots?.includes(normalized))) ?? null;
}

function priceFromSection(section: string, kind: "Input" | "Output"): number | null {
  const row = section.split("\n").find((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return parts.length >= 4 && parts[1] === kind && /^\$/.test(parts[2]);
  });
  const value = row?.split("|")[2]?.trim().match(/^\$([0-9]+(?:\.[0-9]+)?)(?:\s*\/\s*MTok)?$/i)?.[1];
  return value === undefined ? null : Number(value);
}

/** Parse only the exact model's official model page. Catalog, aliases and model names do not prove capabilities. */
export function parseOfficialModelEvidence(
  spec: OfficialModelSpec, sourceText: string, requestedModelId = spec.modelId
): PublishedModelEvidence | null {
  if (sourceText.length > 160_000 || sourceText.length < 200) return null;
  const officialId = sourceText.match(/^Model ID:\s*\x60([a-z0-9.-]+)\x60\s*$/m)?.[1];
  if (officialId !== spec.modelId) return null;
  if (requestedModelId !== spec.modelId) {
    if (!spec.snapshots?.includes(requestedModelId) ||
        !sourceText.split("## Snapshots")[1]?.includes("- \x60" + requestedModelId + "\x60")) return null;
  }

  const openai = spec.provider === "openai";
  const pricingSection = openai
    ? sourceText.split("## Pricing")[1]?.split("## Endpoints")[0]
    : sourceText.split("### Pricing")[1]?.split("### Capabilities")[0];
  if (!pricingSection) return null;
  const input = priceFromSection(pricingSection, "Input");
  const output = priceFromSection(pricingSection, "Output");
  if (input === null || output === null || input !== spec.expectedInputPer1m ||
      output !== spec.expectedOutputPer1m) return null;

  const text = openai
    ? /^- Input modalities: text, image\s*$/m.test(sourceText) &&
      /^- Output modalities: text\s*$/m.test(sourceText) &&
      /^- Reasoning token support\s*$/m.test(sourceText)
    : /^Context window: 1M tokens\b/m.test(sourceText) &&
      /\|\s*Input → output\s*\|\s*Text and images → text\s*\|/m.test(sourceText) &&
      /\|\s*Thinking[^\n|]*\|\s*Adaptive/m.test(sourceText);
  if (!text) return null;

  const endpoints: string[] = [];
  if (openai) {
    if (!/^\|\s*Responses\s*\|\s*\x60v1\/responses\x60\s*\|\s*Supported\s*\|/m.test(sourceText)) return null;
    endpoints.push("responses");
    if (/^\|\s*Chat Completions\s*\|\s*\x60v1\/chat\/completions\x60\s*\|\s*Supported\s*\|/m.test(sourceText)) endpoints.push("chat_completions");
  } else {
    if (!/\|\s*Claude API\s*\|\s*\x60[a-z0-9.-]+\x60\s*\|/m.test(sourceText)) return null;
    endpoints.push("messages");
  }

  const contextMatch = openai
    ? sourceText.match(/^- ([0-9,]+) context window\s*$/m)
    : sourceText.match(/^Context window: (1M) tokens\b/m);
  const outputMatch = openai
    ? sourceText.match(/^- ([0-9,]+) max output tokens\s*$/m)
    : sourceText.match(/Max output: (128K) tokens\b/m);
  const context = openai ? Number(contextMatch?.[1]?.replaceAll(",", "")) : 1_000_000;
  const maxOutput = openai ? Number(outputMatch?.[1]?.replaceAll(",", "")) : 128_000;
  if (!contextMatch || !outputMatch || !Number.isSafeInteger(context) ||
      !Number.isSafeInteger(maxOutput) || context <= 0 || maxOutput <= 0) return null;

  const features = openai ? (sourceText.split("## Supported features")[1]?.split("## Unsupported features")[0]?.split("## Supported tools")[0] ?? "") : "";
  return {
    documentUrl: spec.documentUrl, documentedModelId: spec.modelId,
    inputPer1m: input, outputPer1m: output, reasoningTier: spec.reasoningTier,
    supportsText: true, supportsVision: true,
    supportsWebSearch: openai && /^- web_search\s*$/m.test(features),
    supportsStructuredOutput: openai && /^- structured_outputs\s*$/m.test(features),
    supportsToolCalling: openai ? /^- function_calling\s*$/m.test(features) : true,
    supportedEndpoints: endpoints,
    contextWindowTokens: context, maxOutputTokens: maxOutput,
    pricingTier: "standard_base_per_1m",
    hasVariableLongContextRates: openai && /272K/i.test(pricingSection)
  };
}

/** Public documentation GET: no inference, no credentials and no provider billable call. */
export async function fetchOfficialModelEvidence(
  spec: OfficialModelSpec,
  requestedModelId: string,
  fetcher: typeof fetch = fetch
): Promise<PublishedModelEvidence | null> {
  const url = new URL(spec.documentUrl);
  if (url.protocol !== "https:" ||
      !["developers.openai.com", "platform.claude.com"].includes(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash) return null;
  const response = await fetcher(spec.documentUrl, {
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    headers: { Accept: "text/markdown" }
  });
  if (!response.ok) return null;
  return parseOfficialModelEvidence(spec, await response.text(), requestedModelId);
}
