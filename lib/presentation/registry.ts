import { z } from "zod";

/**
 * Presentation registry infrastructure. The application registers trusted
 * components at build time; untrusted model output can only select these IDs.
 * Runtime registration from a response payload is never supported.
 */

export const presentationInteractionSchema = z.enum([
  "expand", "inspect", "select", "copy",
]);
export type PresentationInteraction = z.infer<typeof presentationInteractionSchema>;

export type ComponentContract<T> = {
  readonly id: string;
  readonly version: number;
  readonly schema: z.ZodType<T>;
  readonly fallback: (payload: T) => string;
  readonly interactions: readonly PresentationInteraction[];
  readonly maxSerializedBytes: number;
};

export type ValidatedPresentationComponent = {
  id: string;
  version: number;
  payload: unknown;
  fallback: string;
  interactions: readonly PresentationInteraction[];
};

const safeId = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_COMPONENT_BYTES = 64 * 1024;

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export class PresentationRegistry {
  private readonly entries = new Map<string, ComponentContract<unknown>>();

  register<T>(contract: ComponentContract<T>): void {
    if (!safeId.test(contract.id) || !Number.isSafeInteger(contract.version) || contract.version < 1 ||
      !Number.isSafeInteger(contract.maxSerializedBytes) || contract.maxSerializedBytes < 1 ||
      contract.maxSerializedBytes > MAX_COMPONENT_BYTES) {
      throw new Error("Invalid presentation component registration");
    }
    const key = this.key(contract.id, contract.version);
    if (this.entries.has(key)) throw new Error("Duplicate presentation component registration");
    const interactions = new Set(contract.interactions);
    if (interactions.size !== contract.interactions.length ||
      contract.interactions.some(value => !presentationInteractionSchema.safeParse(value).success)) {
      throw new Error("Unsupported presentation interaction");
    }
    this.entries.set(key, contract as ComponentContract<unknown>);
  }

  private key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  list(): Array<{ id: string; version: number; interactions: readonly PresentationInteraction[] }> {
    return [...this.entries.values()].map(entry => ({
      id: entry.id, version: entry.version, interactions: [...entry.interactions],
    }));
  }

  validate(id: string, version: number, candidate: unknown): ValidatedPresentationComponent | null {
    const entry = this.entries.get(this.key(id, version));
    if (!entry || byteLength(candidate) > entry.maxSerializedBytes) return null;
    const parsed = entry.schema.safeParse(candidate);
    if (!parsed.success) return null;
    const fallback = entry.fallback(parsed.data);
    if (typeof fallback !== "string" || !fallback.trim() || fallback.length > 32000) return null;
    return {
      id, version, payload: parsed.data, fallback,
      interactions: [...entry.interactions],
    };
  }
}

export const clientCapabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  components: z.array(z.object({
    id: z.string().regex(safeId),
    version: z.number().int().positive(),
  }).strict()).max(64),
}).strict();

export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;

export function negotiatePresentationCapabilities(
  registry: PresentationRegistry,
  claimed: unknown,
): ClientCapabilities {
  const parsed = clientCapabilitiesSchema.safeParse(claimed);
  if (!parsed.success) return { protocolVersion: 1, components: [] };
  const supported = new Set(registry.list().map(item => `${item.id}@${item.version}`));
  return { protocolVersion: 1, components: parsed.data.components
    .filter(item => supported.has(`${item.id}@${item.version}`))
    .filter((item, index, arr) => arr.findIndex(other => other.id === item.id && other.version === item.version) === index),
  };
}

export function canRenderPresentationComponent(
  capabilities: ClientCapabilities,
  id: string,
  version: number,
): boolean {
  return capabilities.components.some(item => item.id === id && item.version === version);
}
