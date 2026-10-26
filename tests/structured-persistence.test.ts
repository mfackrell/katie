import { describe, expect, it } from "vitest";
import { encodeMessageContent, parseMessageContent } from "../lib/data/persistence-store";

const presentation = {
  version: 1 as const,
  fallbackMarkdown: "Revenue rose from 10 to 12.",
  blocks: [
    { type: "chart" as const, chart: "line" as const, title: "Revenue",
      points: [{ label: "Jan", value: 10 }, { label: "Feb", value: 12 }],
      evidence: { origin: "observed" as const, description: "Supplied by user" },
      accessibleSummary: "Revenue increased by 2." },
  ],
};

describe("structured conversation persistence", () => {
  it("round trips a validated presentation with its readable source text", () => {
    const saved = encodeMessageContent({ content: presentation.fallbackMarkdown, presentation });
    const restored = parseMessageContent(saved);
    expect(restored.text).toBe(presentation.fallbackMarkdown);
    expect(restored.presentation).toEqual(presentation);
  });
  it("preserves old raw Markdown without new metadata", () => {
    expect(parseMessageContent("**Existing answer**")).toEqual({ text: "**Existing answer**" });
  });
  it("rejects hostile structured payloads and preserves readable Markdown", () => {
    const saved = JSON.stringify({ text: "Safe answer", presentation: {
      version: 1, fallbackMarkdown: "Safe answer",
      blocks: [{ type: "iframe", src: "https://unsafe.example" }],
    } });
    const restored = parseMessageContent(saved);
    expect(restored.text).toBe("Safe answer");
    expect(restored.presentation).toBeUndefined();
  });
  it("ignores unknown schema versions", () => {
    const restored = parseMessageContent(JSON.stringify({ text: "Prior version", presentation: {
      ...presentation, version: 100,
    } }));
    expect(restored.text).toBe("Prior version");
    expect(restored.presentation).toBeUndefined();
  });
});
