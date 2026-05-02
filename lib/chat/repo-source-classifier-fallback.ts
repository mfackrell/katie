export type RepoSourceClassifierDecision = {
  attach_repo_source: boolean;
  reason: string;
  confidence: number | null;
};

export function __resolveRepoSourceClassifierFailureForTests(activeRepo: boolean, errorMessage?: string): RepoSourceClassifierDecision {
  const fallOpenEnabled = process.env.REPO_CLASSIFIER_FALL_OPEN !== "false";
  if (activeRepo && fallOpenEnabled) {
    return { attach_repo_source: true, reason: "classifier_unavailable_fall_open", confidence: null };
  }
  return { attach_repo_source: false, reason: errorMessage ?? "Classifier returned invalid JSON output and no active repo", confidence: null };
}
