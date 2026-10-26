import { describe, expect, it } from "vitest";
import {
  PRESENTATION_START, PRESENTATION_END, PresentationStreamFilter,
  parsePresentationTail,
} from "../lib/presentation/stream-protocol";

const blocks = [{ type: "chart", chart: "bar", title: "Revenue",
  points: [{ label: "Jan", value: 10 }, { label: "Feb", value: 20 }],
  evidence: { origin: "observed", description: "Values provided by user" },
  accessibleSummary: "Revenue increased from 10 to 20." }];
const rich = "Revenue increased." + PRESENTATION_START +
  JSON.stringify({ version: 1, blocks }) + PRESENTATION_END;

describe("provider-neutral progressive presentation protocol", () => {
  it("separates model-selected rich blocks from canonical visible answer", () => {
    const result = parsePresentationTail(rich);
    expect(result.text).toBe("Revenue increased.");
    expect(result.presentation?.blocks[0].type).toBe("chart");
    expect(result.presentation?.fallbackMarkdown).toBe(result.text);
  });
  it("never leaks JSON while streaming across every character split", () => {
    const filter = new PresentationStreamFilter();
    let output = "";
    for (const ch of rich) output += filter.write(ch);
    output += filter.finish();
    expect(output).toBe("Revenue increased.");
    expect(output).not.toContain("chart");
    expect(output).not.toContain("katie-presentation-v1");
  });
  it("validates ordered interleaving with identical fallback markdown", () => {
    const ordered = "Before. After.";
    const source = ordered + PRESENTATION_START + JSON.stringify({
      version: 1,
      blocks: [
        { type: "markdown", text: "Before. " },
        { type: "selector", title: "Scenario", options: [
          { label: "Base", description: "Conservative" },
          { label: "Stretch", description: "Optimistic" },
        ] },
        { type: "markdown", text: "After." },
      ],
    }) + PRESENTATION_END;
    expect(parsePresentationTail(source).presentation?.blocks.map(x => x.type))
      .toEqual(["markdown", "selector", "markdown"]);
    expect(parsePresentationTail(source).text).toBe(ordered);
  });
  it("streams a plain answer without losing content", () => {
    const filter = new PresentationStreamFilter();
    const input = "Just a normal chat message about revenue.";
    let output = "";
    for (const ch of input) output += filter.write(ch);
    expect(output + filter.finish()).toBe(input);
    expect(parsePresentationTail(input)).toEqual({ text: input, presentation: null });
  });
  it("rejects executable, mismatched and malformed component data", () => {
    const hostile = "Safe." + PRESENTATION_START +
      JSON.stringify({ version: 1, blocks: [{ type: "script", onClick: "alert(1)" }] }) +
      PRESENTATION_END;
    expect(parsePresentationTail(hostile)).toEqual({ text: "Safe.", presentation: null });
    expect(parsePresentationTail("Safe." + PRESENTATION_START + "{").presentation).toBeNull();
    const extra = "Safe." + PRESENTATION_START +
      JSON.stringify({ version: 1, blocks, url: "https://unsafe.example" }) + PRESENTATION_END;
    expect(parsePresentationTail(extra).presentation).toBeNull();
  });
  it("rejects oversized model output while preserving prose", () => {
    const overlarge = "Safe." + PRESENTATION_START + "x".repeat(70_000) + PRESENTATION_END;
    expect(parsePresentationTail(overlarge)).toEqual({ text: "Safe.", presentation: null });
    const filter = new PresentationStreamFilter();
    expect(filter.write(overlarge) + filter.finish()).toBe("Safe.");
  });
});
