import { PresentationRegistry } from "@/lib/presentation/registry";
import { structuredResponseSchema, type StructuredResponse } from "@/lib/chat/structured-response";

/**
 * Single registered implementation for the initial visual-components package.
 * Registry is infrastructure; schema and renderer remain owned by components.
 */
export const presentationRegistry = new PresentationRegistry();

presentationRegistry.register<StructuredResponse>({
  id: "structured-response",
  version: 1,
  schema: structuredResponseSchema,
  fallback: response => response.fallbackMarkdown,
  interactions: ["expand", "inspect"],
  maxSerializedBytes: 64 * 1024,
});

export function validatePresentation(value: unknown): StructuredResponse | null {
  const checked = presentationRegistry.validate("structured-response", 1, value);
  return checked ? checked.payload as StructuredResponse : null;
}
