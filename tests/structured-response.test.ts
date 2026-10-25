import { describe, expect, it } from "vitest";
import { parseStructuredResponse, resolveResponseContent } from "../lib/chat/structured-response";

const valid = {
  version: 1,
  fallbackMarkdown: "Revenue grew to 125.",
  blocks: [
    { type: "markdown", text: "Monthly revenue" },
    { type: "chart", chart: "line", title: "Revenue", unit: "USD",
      points: [{ label: "January", value: 100 }, { label: "February", value: 125 }],
      evidence: { origin: "observed", description: "User-supplied monthly figures" },
      accessibleSummary: "Revenue increased from 100 to 125." },
  ],
};

describe("structured visual response contract", () => {
  it("accepts ordered prose and a numerical chart with provenance", () => {
    expect(parseStructuredResponse(valid)?.blocks.map(b => b.type)).toEqual(["markdown", "chart"]);
  });
  it("rejects arbitrary executable properties", () => {
    expect(parseStructuredResponse({ ...valid, blocks: [
      { type: "cards", items: [{ title: "Bad", description: "X", onClick: "alert(1)" }] },
    ] })).toBeNull();
  });
  it("rejects unapproved component kinds", () => {
    expect(parseStructuredResponse({ ...valid, blocks: [{ type: "iframe", url: "https://evil.example" }] })).toBeNull();
  });
  it("rejects unsupported schema versions", () => {
    expect(parseStructuredResponse({ ...valid, version: 2 })).toBeNull();
  });
  it("rejects nonfinite chart values and missing evidence", () => {
    const chart = valid.blocks[1];
    expect(parseStructuredResponse({ ...valid, blocks: [{ ...chart, points: [
      { label: "A", value: Infinity }, { label: "B", value: 5 },
    ] }] })).toBeNull();
    const { evidence: _evidence, ...unproven } = chart;
    expect(parseStructuredResponse({ ...valid, blocks: [unproven] })).toBeNull();
  });
  it("rejects mismatched comparison cells", () => {
    expect(parseStructuredResponse({ version: 1, fallbackMarkdown: "Comparison",
      blocks: [{ type: "comparison", columns: ["A", "B"], rows: [{ label: "Profit", values: ["10"] }] }],
    })).toBeNull();
  });
  it("preserves legacy Markdown if payload is invalid or absent", () => {
    expect(resolveResponseContent("Original reply", null)).toEqual({ markdown: "Original reply", structured: null });
    expect(resolveResponseContent("Original reply", { type: "script" }).markdown).toBe("Original reply");
    expect(resolveResponseContent("Original reply", valid).markdown).toBe(valid.fallbackMarkdown);
  });
});
