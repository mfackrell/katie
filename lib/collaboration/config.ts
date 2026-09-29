export type CollaborationConfig = {
  enabled: boolean;
  maxDelegations: number;
  maxDepth: number;
  maxContributionChars: number;
  maxTotalContributionChars: number;
  participantTimeoutMs: number;
  maxTotalDurationMs: number;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function getCollaborationConfig(): CollaborationConfig {
  return {
    enabled: process.env.KATIE_COLLABORATION_ENABLED !== "false",
    maxDelegations: boundedInteger(
      process.env.KATIE_COLLAB_MAX_DELEGATIONS,
      5,
      1,
      12,
    ),
    maxDepth: boundedInteger(
      process.env.KATIE_COLLAB_MAX_DEPTH,
      2,
      0,
      4,
    ),
    maxContributionChars: boundedInteger(
      process.env.KATIE_COLLAB_MAX_CONTRIBUTION_CHARS,
      12_000,
      1_000,
      40_000,
    ),
    maxTotalContributionChars: boundedInteger(
      process.env.KATIE_COLLAB_MAX_TOTAL_CONTRIBUTION_CHARS,
      48_000,
      4_000,
      120_000,
    ),
    participantTimeoutMs: boundedInteger(
      process.env.KATIE_COLLAB_PARTICIPANT_TIMEOUT_MS,
      120_000,
      10_000,
      240_000,
    ),
    maxTotalDurationMs: boundedInteger(
      process.env.KATIE_COLLAB_MAX_TOTAL_DURATION_MS,
      240_000,
      30_000,
      280_000,
    ),
  };
}
