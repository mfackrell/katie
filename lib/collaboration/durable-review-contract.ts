import { createHash } from "node:crypto";
import { getSupabaseAdminClient } from "@/lib/data/supabase/admin";
import type { IndependentAssessment } from "@/lib/collaboration/review-contract";
import type { ReviewAudit } from "@/lib/collaboration/required-review";

export type DurableReviewScope = { actorId: string; projectSourceId: string; objectiveSourceId: string };
type Validation = NonNullable<ReviewAudit["contractValidation"]>;
type Row = { assessment: IndependentAssessment; validation: Validation; source_hash: string };
const fingerprint = (parent: string, objective: string) =>
  createHash("sha256").update(JSON.stringify([parent.trim(), objective.trim()])).digest("hex");
const scoped = (scope: DurableReviewScope) =>
  getSupabaseAdminClient().from("actor_review_contracts")
    .eq("actor_id", scope.actorId)
    .eq("project_source_id", scope.projectSourceId)
    .eq("objective_source_id", scope.objectiveSourceId);

export async function readDurableReviewContract(scope: DurableReviewScope, parent: string, objective: string) {
  const sourceHash = fingerprint(parent, objective);
  const { data, error } = await scoped(scope).select("assessment,validation,source_hash")
    .eq("source_hash", sourceHash).maybeSingle<Row>();
  if (error) throw new Error("Could not read durable contract: " + error.message);
  if (!data || data.source_hash !== sourceHash || data.validation?.verdict !== "approve" ||
      !data.assessment?.taskContract || !Array.isArray(data.assessment.taskContract.requirements)) return null;
  return { assessment: data.assessment, validation: data.validation };
}

export async function saveDurableReviewContract(
  scope: DurableReviewScope, parent: string, objective: string,
  assessment: IndependentAssessment, validation: Validation
) {
  if (validation.verdict !== "approve") throw new Error("Only validated contracts may be saved");
  const sourceHash = fingerprint(parent, objective);
  // Once validated, a source-version contract is immutable. Concurrent requests
  // may race to insert it, but must never rewrite each other's accepted criteria.
  const existing = await readDurableReviewContract(scope, parent, objective);
  if (existing) return existing;
  const client = getSupabaseAdminClient();
  const { error } = await client.from("actor_review_contracts").insert({
    actor_id: scope.actorId, project_source_id: scope.projectSourceId,
    objective_source_id: scope.objectiveSourceId, source_hash: sourceHash,
    assessment, validation
  });
  const saved = await readDurableReviewContract(scope, parent, objective);
  if (!saved) throw new Error("Durable review contract did not survive read-back: " + (error?.message ?? "missing row"));
  return saved;
}
