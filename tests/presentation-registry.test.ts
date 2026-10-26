import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PresentationRegistry, negotiatePresentationCapabilities, canRenderPresentationComponent,
} from "../lib/presentation/registry";

function makeRegistry() {
  const registry = new PresentationRegistry();
  registry.register({
    id: "metric", version: 1,
    schema: z.object({ label: z.string().max(60), value: z.number().finite() }).strict(),
    fallback: data => `${data.label}: ${data.value}`,
    interactions: ["inspect"],
    maxSerializedBytes: 2000,
  });
  return registry;
}

describe("universal presentation registry", () => {
  it("accepts only explicitly registered schema versions and payloads", () => {
    const registry = makeRegistry();
    expect(registry.validate("metric", 1, { label: "Revenue", value: 42 })?.fallback).toBe("Revenue: 42");
    expect(registry.validate("metric", 2, { label: "Revenue", value: 42 })).toBeNull();
    expect(registry.validate("arbitrary", 1, {})).toBeNull();
  });
  it("rejects injection properties and invalid numeric data", () => {
    const registry = makeRegistry();
    expect(registry.validate("metric", 1, { label: "X", value: 10, onClick: "alert(1)" })).toBeNull();
    expect(registry.validate("metric", 1, { label: "X", value: Infinity })).toBeNull();
  });
  it("refuses oversized payloads before schema validation", () => {
    const registry = makeRegistry();
    expect(registry.validate("metric", 1, { label: "x".repeat(3000), value: 2 })).toBeNull();
  });
  it("rejects duplicate registration and unauthorized interactions", () => {
    const registry = makeRegistry();
    expect(() => registry.register({
      id: "metric", version: 1, schema: z.unknown(), fallback: () => "x",
      interactions: [], maxSerializedBytes: 100,
    })).toThrow();
    expect(() => registry.register({
      id: "delete-data", version: 1, schema: z.unknown(), fallback: () => "x",
      interactions: ["deploy" as "inspect"], maxSerializedBytes: 100,
    })).toThrow();
  });
  it("negotiates only approved client capabilities", () => {
    const registry = makeRegistry();
    const result = negotiatePresentationCapabilities(registry, {
      protocolVersion: 1, components: [
        { id: "metric", version: 1 }, { id: "metric", version: 1 },
        { id: "unapproved", version: 1 }, { id: "metric", version: 2 },
      ],
    });
    expect(result.components).toEqual([{ id: "metric", version: 1 }]);
    expect(canRenderPresentationComponent(result, "metric", 1)).toBe(true);
    expect(canRenderPresentationComponent(result, "metric", 2)).toBe(false);
    expect(negotiatePresentationCapabilities(registry, { protocolVersion: 99 }).components).toEqual([]);
  });
});
