export function buildGenerationFailureChunk(args: {
  message: string;
  provider?: string | null;
  modelId?: string | null;
  stage?: "provider_selection" | "generation_after_selection";
  recoverable?: boolean;
}) {
  return {
    type: "generation_failure" as const,
    stage: args.stage ?? "generation_after_selection",
    message: args.message,
    provider: args.provider ?? null,
    modelId: args.modelId ?? null,
    recoverable: args.recoverable ?? false
  };
}
