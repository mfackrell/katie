/** Explicit evidence states: matching SHAs do not independently prove production alias or behavior. */
export function reconcileSelfInspectionEvidence(input: {
  repositorySha?: string | null;
  runtimeSha?: string | null;
  productionSha?: string | null;
  productionAliasVerified?: boolean;
}) {
  const valid = (sha?: string | null): sha is string => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);
  const repositorySha = valid(input.repositorySha) ? input.repositorySha : null;
  const runtimeSha = valid(input.runtimeSha) ? input.runtimeSha : null;
  const productionSha = valid(input.productionSha) && input.productionAliasVerified === true ? input.productionSha : null;
  const sourceRuntime = !repositorySha || !runtimeSha ? 'unknown' : repositorySha === runtimeSha ? 'match' : 'mismatch';
  const independentlyVerified = Boolean(productionSha);
  const sourceProduction = !repositorySha || !productionSha ? 'unknown' : repositorySha === productionSha ? 'match' : 'mismatch';
  return {
    repositorySha, runtimeSha, independentlyVerifiedProductionSha: productionSha,
    sourceRuntime, sourceProduction,
    productionAliasVerification: independentlyVerified ? 'verified' : 'unverified',
    behaviorVerification: 'untested',
    explanation: 'Repository SHA identifies source, runtime SHA is self-reported by the running process. Only independent alias/deployment attestation can establish production assignment. Matching SHAs do not prove behavior.',
  };
}
