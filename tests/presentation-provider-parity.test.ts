import { describe, expect, it } from "vitest";
import { getAdaptiveResponseCompositionInstruction } from "../lib/chat/adaptive-response-composition";
import {
  PRESENTATION_START, PRESENTATION_END, PRESENTATION_GENERATION_GUIDANCE,
  parsePresentationTail,
} from "../lib/presentation/stream-protocol";

const providers = ["openai", "google", "anthropic", "grok"] as const;

describe.each(providers)("provider-neutral response contract: %s", provider => {
  it("shares natural conversational and visual selection instructions", () => {
    const composition = getAdaptiveResponseCompositionInstruction();
    expect(composition).toContain("context-appropriate emoji");
    expect(composition).toContain("Never add an emoji merely to fill a quota");
    expect(PRESENTATION_GENERATION_GUIDANCE).toContain("markdown blocks must concatenate EXACTLY");
    expect(PRESENTATION_GENERATION_GUIDANCE).toContain("selector");
  });

  it("accepts equivalent ordered visual output regardless of provider identity", () => {
    const answer = "Revenue rose. Consider the forecast.";
    const blocks = [
      { type: "markdown", text: "Revenue rose. " },
      { type: "metric", label: "Revenue", value: "$1,200" },
      { type: "markdown", text: "Consider the forecast." },
      { type: "selector", title: "Scenario", options: [
        { label: "Base", description: "Base forecast" },
        { label: "Upside", description: "Upside forecast" },
      ] },
    ];
    const modelText = answer + PRESENTATION_START + JSON.stringify({ version: 1, blocks }) + PRESENTATION_END;
    const parsed = parsePresentationTail(modelText);
    expect(parsed.text).toBe(answer);
    expect(parsed.presentation?.blocks.map(block => block.type))
      .toEqual(["markdown", "metric", "markdown", "selector"]);
    // A provider name must never determine the schema or renderer selected.
    expect(provider).toBeTruthy();
  });

  it("falls back when rich output is unsupported or refused", () => {
    expect(parsePresentationTail("A direct conversational answer.").presentation).toBeNull();
    const invalid = "Plain answer." + PRESENTATION_START +
      JSON.stringify({ version: 1, blocks: [{ type: "execute", action: "deploy" }] }) + PRESENTATION_END;
    expect(parsePresentationTail(invalid)).toEqual({ text: "Plain answer.", presentation: null });
  });
});
