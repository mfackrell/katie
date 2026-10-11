export type ReviewMode = "adaptive" | "always" | "off";

export function normalizeReviewMode(value: unknown): ReviewMode {
  return value === "always" || value === "off" ? value : "adaptive";
}

export function shouldEnableActorCollaboration(mode: ReviewMode, adaptive: boolean): boolean {
  return mode === "always" || (mode === "adaptive" && adaptive);
}
