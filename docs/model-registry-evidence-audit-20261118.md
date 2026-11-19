# Model registry eligibility audit — 2026-11-18

## Production baseline (read-only Supabase query)

| Provider | Active | Verified | Restricted | Estimated rate | Missing rate |
|---|---:|---:|---:|---:|---:|
| OpenAI | 100 | 0 | 100 | 90 | 10 |
| Anthropic | 15 | 0 | 15 | 15 | 0 |
| Google | 50 | 0 | 50 | 29 | 21 |
| Grok | 13 | 0 | 13 | 0 | 13 |
| **Total** | **178** | **0** | **178** | **134** | **44** |

The old enrichment path stamps all discovered models as capability_status=heuristic, uses
model-name regexes for capabilities (GPT-6 is not recognized as high reasoning), and treats
LiteLLM catalog prices as estimated while stamping pricing_verified_at like an official check.
Old verified prices stop surviving refresh after 24 hours; capabilities are never retained.
The periodic authenticated registry GET/POST could also issue **paid** quarantined-model
inference probes without a separate bounded owner authorization. The correction disables
that automatic path.

## Exact gate inventory

| Gate | Existing admission behavior | Outcome / disposition |
|---|---|---|
| General chat automatic routing (master-router) | Active registry records with verified OR restricted eligibility; disabled/manual-only excluded | Restricted is **not** universal exclusion; preserved |
| Intent/modality matching (model-intent) | Text, image, video, web-search paths filter by metadata, with name-based fallbacks | First-party documented fields now available; router's separate algorithms unchanged |
| Control-plane decision models (master-router and model-intent) | Curated exact-ID allowlists, endpoint-specific handling | **Remaining integration:** lists omit GPT-6 and Claude 5.5 families; change belongs to routing agents after verifying instruction/schema compatibility |
| Policy engine (policy-engine) | Optional hard request cap $0.12; relative-cost cutoff 3x cheapest; latency/quality constraints; can be enforced | **Remaining integration:** distinguish optimization from owner authorization in separate routing work; do not bypass legitimate spending controls |
| Critique collaboration | Verified eligibility and high reasoning, different provider | New documented models can qualify after successful registry verification |
| Organization executive gate | OpenAI/Anthropic + high reasoning + verified capabilities, pricing, eligibility + both verification timestamps <24h | Preserved; documentation can now supply fresh evidence, but does not authorize paid execution |
| Mission orchestration | Bounded native transport, provider discovery, health, reservation and original approved mission envelope | Preserved; discovery is not proof of successful endpoint inference |
| Missing price | Catalog absent or estimated, no verified price | Cannot be treated as independently verified; needs source validation or bounded owner decision |
| Upstream 404 | Model inactive and quarantined | Preserved; no automatic paid retry |
| Transient HTTP 429/5xx/timeouts | Never definitive unavailability | Preserved; source documentation failure retains historical evidence |
| Manual model selector | Returns active registry rows; inactive/quarantined omitted | Existing shape maintained for compatibility; authenticated diagnostics explain hidden or restricted models |
| Video/image-generation endpoints | Require separate modality/endpoint support | Documentation on text models does not qualify image/video generation |

## Evidence-backed models

The following first-party documentation sources are reviewed by the exact-ID parser
when the *configured account's provider discovery* also lists the model. Published
capabilities and Standard base rates are not a live paid inference receipt.

| ID(s) | Source | Base input/output per 1M tokens | Documented transport |
|---|---|---|---|
| gpt-6.2-astra | https://developers.openai.com/api/docs/models/gpt-6.2-astra | $8 / $40 | Responses and Chat Completions |
| gpt-6-astra | https://developers.openai.com/api/docs/models/gpt-6-astra | $10 / $50 | Responses and Chat Completions |
| gpt-6.2-sol | https://developers.openai.com/api/docs/models/gpt-6.2-sol | $2 / $10 | Responses and Chat Completions |
| gpt-6-sol | https://developers.openai.com/api/docs/models/gpt-6-sol | $2 / $10 | Responses and Chat Completions; Chat has feature limitations |
| gpt-5.5-pro (+ exact 2026-04-23 snapshot) | https://developers.openai.com/api/docs/models/gpt-5.5-pro | $30 / $180 | **Responses only**; long-running requests |
| gpt-5.4-pro (+ exact 2026-03-05 snapshot) | https://developers.openai.com/api/docs/models/gpt-5.4-pro | $30 / $180 | **Responses only** |
| claude-opus-5-5 | https://platform.claude.com/docs/en/models/opus-5-5/overview | $4 / $20 | Claude Messages |
| claude-sonnet-5-5 | https://platform.claude.com/docs/en/models/sonnet-5-5/overview | $2 / $10 | Claude Messages |
| claude-fable-5-2 | https://platform.claude.com/docs/en/models/fable-5-2/overview | $8 / $40 | **Pending:** its own documentation page must be reachable and independently parse/qualify |

No model is promoted merely because it appears on that table. The authenticated
refresh must fetch the actual **first-party Markdown**, validate its exact published
model ID, documented text/image/reasoning and output limits, native endpoint, both
token rates and any exact snapshot. Changed published pricing preserves verified
capabilities while withdrawing price verification pending review. If a docs request
fails, previous evidence retains its original timestamp; the strict 24-hour gates
fail closed. Catalog-only records remain estimated.

**Pricing scope:** The stored verified rates are published **Standard base** rates,
not a guarantee about the specific request invoice. Long-context (>272K) OpenAI
requests can incur higher input/output rates; regional processing, cached tokens,
Batch/Fast tiers and tools can also alter prices. Before authorizing high-exposure
or long-context requests, existing financial admission must account for the actual
usage tier or request explicit bounded owner approval. This PR does not alter
mission, accounting or owner permissions.

## Before/after eligibility matrix (pending release)

| Cohort | Before | After a successful authorized refresh |
|---|---|---|
| Documented model listed by configured provider, first-party page passes | restricted / heuristic | verified / documented, with documented price and verified-at timestamps |
| Documented model whose price differs from the reviewed schedule | restricted / heuristic | **restricted** / verified capabilities, estimated or missing price pending review |
| Documented model whose source is unavailable | restricted / heuristic | retained original evidence and verification age; no fabricated renewal |
| Unrecognized or undocumented model | restricted / heuristic | restricted / heuristic, explicit reason: no authoritative verification |
| Unsupported modality/endpoint | filtered by routing | still filtered by routing; no automatic eligibility |
| 404-quarantined model | inactive/disabled | inactive/disabled until **separate owner-authorized paid test** |
| Provider with no configured credentials | undiscovered | undiscovered; no inferred account access |

The actual promotion count cannot be claimed before successful authenticated refresh
and production deployment. A simulation is not a production result.

## Operational diagnostics

Authenticated GET /api/internal/model-registry/diagnostics with x-internal-token
returns model IDs, capability and price source, freshness, eligible status,
reasoning tier, documented native endpoints, account-inference qualification state
and reasons for exclusion. It never returns provider credentials or user prompts.

## Verification / acceptance outstanding

- Deterministic parser, source-integrity, rate-drift, stale-evidence and no-paid-request tests.
- TypeScript, full Node/Vitest suite, build, smoke and CI.
- Independent security and accounting review.
- Source-specific documentation revalidation in deployment (no unapproved paid inference).
- Owner-authorized release; **no merge, deployment or database migration by this PR**.

Specific provider-account eligibility, endpoint authorization, and real answer quality
still require a smallest-possible paid verification proposal and owner approval.
The registry can independently verify published specifications; it cannot claim
unmeasured response quality or guarantee account-level inference solely from listModels().

## First-party documentation checkpoint — 2026-11-19 UTC

Read-only source inspection confirmed the publicly served first-party Markdown pages
for **eight of nine** configured models. This is a documentation check, not an
authenticated registry refresh, paid model inference, or proof that the deployed
server's parser has successfully processed each live HTTP response:

| Source cohort | Public Markdown status | Documented conclusion |
|---|---|---|
| `gpt-6.2-astra`, `gpt-6-astra`, `gpt-6.2-sol`, `gpt-6-sol` | Accessible | Exact model IDs, base input/output prices and Responses + Chat endpoint rows found |
| `gpt-5.5-pro`, `gpt-5.4-pro` | Accessible | Exact model IDs, both snapshot IDs and base prices found; Responses supported, Chat not supported |
| `claude-opus-5-5`, `claude-sonnet-5-5` | Accessible | Exact IDs and Anthropic Messages identifiers, 1M context, 128K max output, base prices and thinking capabilities found |
| `claude-fable-5-2` | **Not accessible to this read-only retrieval** | Comparison references in other model pages are **not sufficient** to qualify its own page. Keep unverified; do not fabricate a price check |

The directly inspected URL set is the eight OpenAI/Anthropic first-party pages linked
in the evidence-backed model table above, with `.md` appended. Pages may change
independently of this audit; any subsequent scheduled verification must validate
the actual current response under the parser's exact ID, price and endpoint checks.
The offline suite now also includes source-shaped multi-model/snapshot fixtures,
numeric-string positive cases and fail-closed invalid-value cases. A green CI result
would establish only those offline tests; actual deployed account eligibility and
billing-specific surcharge controls require their separate acceptance gates.

**Release gate remains:** no automatic inference requalification, no assumption that
a documented model is authorized for billing, no routing-agent source changes, and
no merge/deployment without independent review and owner authorization.


## D6 owner-decision brief — 2026-11-19 (NO production policy implemented)

### Independently inspected impact

A read-only query of Katie's live public.model_registry on 2026-11-19 UTC showed:
264 total rows; 178 active, 86 inactive; 178 active restricted, **zero active
verified**, **zero verified provider/provider-label records across active and
inactive**, and zero active provider_documentation-source rows. This is a
point-in-time observation, NOT a guarantee about other environments, future
refreshes or historical states. No production update occurred.

The current D6 branch in buildRoutingRegistrySnapshot accepts two editable
source_metadata fields (capability_source=provider and pricing_source=provider)
without a provider-origin receipt. A stored previously documented model with
0.10/40 instead of approved 8/40 can spoof these labels and bypass economic
qualification. Repository/schema investigation found no independently
verifiable provider capability+pricing producer or receipt. Adding a third
untrusted JSON field does not establish provenance.

Existing imported-production D6 tests expose the bypass; full strict CI on
test-only SHA 4af32570257c50c41428b5094d59496c7565bad7 is intentionally
RED: https://github.com/mfackrell/katie/actions/runs/44489521919 .
Native PostgreSQL, video/review and website checks on that SHA passed.
The D5 production code was restored byte-for-byte; no new D6 fix exists.

### Option A: explicit OWNER authorization REQUIRED

Propose a narrow in-memory routing-read gate: retain persisted verified only
when the already implemented same-model first-party documentation, standard
base pricing, expiry and scope checks pass, OR a future separately authorized
independently attestable provider producer/receipt validates. **While no
provider receipt exists, provider/provider labels alone never prove verified**;
those records are effectively restricted at routing read, even if stored as
verified. Current observed records to be downgraded: ZERO. Potential legacy
or future provider-only verified records outside the observed snapshot could
lose verified eligibility. This is a policy tightening and requires owner
approval notwithstanding zero observed current impact.

Preserve valid first-party documented verified records; pre-existing
restricted/manual_override_only/disabled, inactive/quarantine and owner/actor
rules; routing algorithms, paid-inference budget, financial controls and
documented endpoint rules. Do not rewrite DB, call providers or alter A/B/C
files. Reversible by reverting the reviewed read-time gate, not by altering
stored prices, timestamps or evidence.

### Option B: keep legacy behavior and HOLD release

Without owner approval for Option A, or a separately approved, trustworthy
external provider attestation mechanism and producer, D6 remains exploitable.
Do not claim QA PASS or create a fabricated provider-origin positive fixture.

### Post-approval acceptance matrix

- Actual imported production snapshot builder: forged provider/provider labels
  and 0.10/40, 8/41, labels-only 8/40, fabricated metadata receipt and
  heuristic/missing-status combinations are ALL restricted.
- Current exact same-model documented 8/40 positive remains verified;
  missing/future/stale >24h timestamp, source/price/scope drift fail closed.
- Restricted/manual/disabled and inactive/quarantine statuses unchanged.
- A genuinely independent provider-origin positive case must use a real
  authorized producer and verifiable receipt; no mutable-label-only fixture.
- D6 RED-to-GREEN test logs, complete new-head strict/native PostgreSQL CI,
  and Agent B independent non-author PASS required before owner release review.

**No owner D6 authorization has been received. This is a proposal only.**
