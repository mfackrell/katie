# Read-only lifecycle capacity forecasting (Task2A)

`lib/projects/lifecycle-capacity.mjs` exposes the reusable, versioned contract in
`lifecycle-capacity.d.mts`. Its pure implementation lives beside the trusted native
host so the existing explicit staging boundary can copy it without importing code
from a candidate worktree. `native-capacity-forecast.mjs` is the read-only adapter.

## Inspection and reuse

The existing `resource-forecast.mjs` estimates whole-project scope using declared
heuristic unit rates. `resource-economics.mjs` enriches those estimates with verified
prices, observed token mix, throughput and optional calibration. Neither proves
remaining native-call capacity or completed recovery phases. Their heuristic
numbers are deliberately not reclassified as measured lifecycle observations.
`recovery-budget.ts` concerns specification recovery and writes approval events;
this deliverable does not invoke or modify that approval path.

The adapter reuses the existing effective mission token/call RPCs, monetary-control
RPC, immutable continuation reserve definitions, account/mission receipts and
verified model registry. Task1's existing artifact/provenance/scope validation and
restoration run before forecasting. No competing ledger or authorization mechanism
is introduced. The existing lifecycle, admission, spending, retry and grant rules
remain authoritative and unchanged.

## Forecast method

Each remaining stage has its own calls, input/output tokens, time and model/API
cost. Deterministic verification and browser/delivery are distinct from model work;
zero model calls does not imply known duration or free external APIs.

At least three distinct, comparable completed phase observations are required for
a numerical estimate. Comparison requires the same approved scope/cohort, project,
stage and trusted evidence source. The expected value is the upper median; the
contingency is the observed maximum minus that median. The projected requirement
is their sum. This is an explainable empirical envelope, not a confidence interval,
guarantee, or an arbitrary multiplier. Additional confirmed repair iterations
increase remaining demand explicitly; they do not gain authority. A partial phase
is not prorated without evidence of its remaining fraction.

Sparse, conflicting, missing or unlinked observations leave estimates unknown.
Known minimum work can still prove a shortage: a required model phase needs at
least one request; existing DO completion needs its four worker/routing requests.
The current bounded native lifecycle plans one possible repair iteration, records
it as not required when the actual review/test decision skips it, and does not
authorize extra corrective iterations. In-progress restored repair does not repeat
completed implementation or initial review. Restored WIP is not marked verified.

Costs use verified standard-tier input/output rates, ignoring cache discounts.
Rates are requested as database text; unsafe numeric transport values remain
unknown. Arithmetic uses integer/rational values and microUSD strings, retaining
backend precision. Token-based model costs round upward to microUSD. Pricing older
than24hours, missing pricing, unsupported tiers or unbounded other API costs leave
the monetary projection unknown. Native pricing is never substituted for a future
DO completion or assessment model that routing has not yet chosen.

## Authority and live snapshots

Account token exposure is settled spending plus reserved/unresolved holds. Mission
exposure is max(actual,reserved), not their sum. Effective limits come from live
RPCs, never the approval-time `callsRemaining`/`developmentRemainingTokens` snapshots.
Native capacity excludes protected DO completion calls/tokens and assessment tokens.
Each dimension is compared separately; dollars or tokens cannot cover a call deficit.
Monetary headroom uses the existing conservative cumulative exposure, including
uncertain reservations. An unknown value remains null, never implicit zero.

The native adapter supports the existing v5/v6 Full contracts. Unsupported older
contracts report unknown. It reads bounded history twice and rejects changing,
truncated or inconsistent snapshots. These are advisory snapshots, not transactional
admissions. Execution-grant state is checked separately: before issuance, execution
permission is unknown; stopped/revoked/expired grants are not reported usable.
No positive forecast grants spending permission.

Forecasts run after authenticated restoration and before grant issuance, before
each native phase, and at native handoff to DO completion. Only actual successful
scope checkpoints/review/verifier outcomes mark phases complete. The bounded
diagnostic artifact retains assessments and receipt-linked phase observations;
there are no database writes from the planner. Forecast failure reports uncertainty
and cannot deny otherwise permitted requests, invoke retries, request approvals,
extend time, dispatch providers or change budgets.

## Evidence and limitations

Run41139165988's retained artifact13017622340 shows implementation and review exited
successfully, repair failed, and completion was false. Its log records gateway
admission denial during repair. The synthetic regression models the documented
eleven exhausted native calls with four protected completion calls, available tokens
and dollar headroom. It requires a native-call shortage without borrowing reserves.

Old artifacts lack receipt-linked per-phase input/output and duration observations;
they cannot supply invented calibration. New successful phases record bounded
receipt identities and measurements for future comparable recovery forecasts.
Assessment call limits, future routed model pricing, deployment/API charges and
full end-to-end timing often remain unknown. The planner reports those gaps, so a
complete numerical real-task forecast is not promised with sparse evidence.
Per-request peak reservations/context growth still require the existing admission
checks; projected settlement is not a reservation guarantee. Existing seven-day
recovery-artifact retention is unchanged.

## Verification

`node --test tests/lifecycle-capacity.test.mjs tests/native-capacity-forecast.test.mjs`
tests every resource dimension, reserves, missing/pricing/history evidence, repair
progress, deterministic output, read-only integrity and the Take Eleven pattern.
Existing native preflight/retry/lifecycle tests ensure forecast failures/shortfalls
cannot change grants or execution policy. The explicit workflow staging test and
native qualification exercise trusted-host integration. Full CI covers existing
resource economics, accounting, recovery, TypeScript, build and browser checks.

No paid inference, production accounting mutation, approval UI or Task2B/C work is
part of this deliverable.
