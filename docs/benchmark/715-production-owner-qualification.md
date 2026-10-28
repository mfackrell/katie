# Production owner qualification for Take Eleven #715

The owner must manually run **Benchmark 715 production owner qualification** on `main` in GitHub Actions and explicitly check its `authorize` input. Approve the existing `benchmark-paid` protected environment if GitHub requests it. Do not have a model dispatch it or open a synthetic owner issue.

This approves moving the unused #715 benchmark allowance to production: $30 total, separate $10/350,000-token caps, and one fixed four-hour deadline. It does not approve a generated project specification, a development task, an execution grant, or publishing the game. No model inference runs during qualification. The preflight invokes the existing gateway qualification with synthetic responses.

The workflow reuses the existing HMAC and staging service credentials. Production database credentials stay in Vercel. Both ends verify the exact #715 owner comment, authenticated GitHub actor/triggering actor, repository identity, `main` workflow, deployed commit and current nonbillable checks. Production verifies those facts and current pricing before staging is frozen.

The source transaction verifies the original three synthetic trials, eight settled synthetic receipts and no live grants. It locks account rows, freezes the unused staging allowances, and prevents subsequent staged paid replicates. The production transaction preserves that experiment identity, creates replicate 2 and its three accounts atomically, and retains the authenticated run and transfer evidence. Staging qualification code and its synthetic receipts are unchanged.

Repeated or interrupted runs reuse the same transfer, accounts and original deadline. They never reset spending, extend the deadline or replace the experiment. An error after transfer must be resumed by rerunning this workflow. The transfer checkpoint is saved as an Actions artifact even if production fails. An expired or conflicting authorization is a real stop requiring a separate owner decision; do not delete its records.

Production admission rechecks the fixed deadline, revocation, exact model, positive verified pricing no older than 24 hours, the conservative $28/M ceiling, unresolved/overrun calls and 350,000-token budget. With all token types valued at $28/M, each arm's maximum is $9.80. Existing provider/tool restrictions remain in force.

After successful qualification, use the returned Full `trialId` with the production Full dispatch configuration. Create a new Take Eleven project through Katie's normal DO mechanism; preserve the historical blocked project. Obtain formal scope and task approvals through their existing controls. The qualification receipt is not project completion or browser acceptance.

Production is protected by Vercel Authentication. The owner qualification job uses the existing Katie automation bypass value from the GitHub Actions secret `VERCEL_AUTOMATION_BYPASS_SECRET`. If absent, the owner must copy an existing valid Katie automation bypass into that repository secret before launching. Do not disable Deployment Protection or put the value in workflow inputs, logs, source, or issue comments. The transport sends it only to the fixed production qualification endpoint, rejects redirects, and still requires the separately signed and authenticated owner-run checks. A missing or invalid transport credential fails before staging transfer.
