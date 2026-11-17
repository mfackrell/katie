# Reviewer verdict evidence patch for #1089

This patch is based on main 42b5996881fc818613bc14debe6e1e234e99a902. The local release ref resolves to 15c6312b7bde9110eb91f8cff01f95749955aaad. Remote heads and CI 44140932808 have not been reverified over the network. Transplant this patch onto #1089; it is not a replacement release candidate. No deployment, production query, paid evaluation, push, merge, or workflow change was performed.

Stage 2 receives a separate `reviewer_quality_evidence` field. It cannot alter numeric scores or deterministic candidate order. The existing receipt economics and provider quotation paths are untouched, including unverified delivery receipts. Missing migration or evidence fails to unknown. Guest and orchestrator scopes never query the RPC.

The service-only RPC confirms owner/actor/chat using the existing binding verifier, then joins chat_requests by exact request ID and actor/chat UUID strings to a completed workflow in that scope. Only the workflow's server-classified `routing-delivery-audit:v1.classifiedIntent` can establish task alignment. Review free text, independentAssessment.objective, and unrelated chat/workflow records cannot establish alignment. It admits at most 100 qualified reviews within 30 days, excludes the current request, future timestamps, self-review, missing independent assessment, and verdicts whose reviewed-answer hash differs from the delivered finalHash. Both approve and revise remain categorical judgments; neither proves objective correctness.

Only generating provider/model, counts, and observation dates leave SQL. Reviewer identity, raw answer, prompts, assessments, findings, hashes and request IDs do not. The application explicitly projects the aggregate fields and adds categorical independent-reviewer provenance, window, selection bias and uncertainty. No approval percentage or deterministic quality bonus is calculated.

## Remaining acceptance limitation

Historical review_audit records have no classified task tag. Reviews qualify only if their exact request has the classified workflow checkpoint and a verdict linked to the delivered answer. Consequently the previously reported 122 verdicts / 79 bound verdicts are NOT claimed as eligible task evidence. The eligible real corpus size is unknown without a separately authorized read-only check. Missing checkpoint, missing assessment, missing hash-linked review history, or unmatched task returns unknown. Main does not yet write the release's classified checkpoint, so this extension relies on transplantation onto #1089. No historical text-based backfill is attempted. Release QA/owner must decide whether this defensible coverage is sufficient.

## Validation

New native PostgreSQL regression covers scoped corpus, owner/actor/chat mismatches, anon/authenticated execute denial, service execution, task absence/mismatch, self-review and missing assessment, replaced-answer verdicts, future/expired observations, bounded sampling and no raw content. Six task regressions use real OpenAI and Anthropic adapters with network blocked, preserving native serialized preparation and pricing. No existing tests were changed.

Local validation passed: `npm run typecheck`, `npx tsc -p tsconfig.tests.json`, and 83 tests across the new reviewer suites plus control-plane-economics, model-intent-routing, routing-decision-audit and required-review. Native PostgreSQL 18 runs socket-free in single-user mode with real SET ROLE ACL checks; SQL is supplied through a file descriptor to avoid a sandbox pipe stall. Full CI/browser suites and the remote exact-head CI status are not claimed. Changes are intentionally uncommitted for the orchestration workflow; no patch commit SHA exists yet.
