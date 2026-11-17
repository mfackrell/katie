# Standalone two-stage routing handoff (#1070)

Base checkout: `e8321fda6100c6d23f0445877b8b1f425771b244`, base tree
`578e72495d5101a69ee5393aaa4fcf9c528bb673`. The surrounding workflow owns
committing, independent testing/review and PR publication. No fetch, push,
deployment, production reads/writes or paid model evaluation was performed.

## Architecture audit and authority

`app/api/chat/route.ts` assembles actor-scoped context and applies explicit
manual and native-video compatibility handling. Ordinary automatic chat calls
`chooseProvider` in `master-router.ts`. The router loads the eligible registry,
selects qualified control-plane models, calls
`inferRequestClassificationWithSource`, filters incompatible/excluded candidates,
then calls `chooseRoutingWithLLM`. Both control-plane calls retain existing
standalone admission, durable activities and actual-cost helper selection.

The baseline already used separate LLM calls, but classification could be
replaced by chart/forecast keywords, code-generation sanitization and the
written-objective guard. `scoreModelsForIntent`/score breakdowns supplied
provider/family bonuses and actor routing boosts. The selection prompt received
these numerical priors and category-based quality preferences, including a Grok
refusal preference. Optional `candidate-shortlist` truncation could hide models
within each provider. `policy-engine` was already advisory after successful LLM
selection; that authority is preserved.

The chat route also contained a *post-selection* creative override using
`preferredClaudeCreativeModel` (Fable, then Sonnet) plus a forced Grok fallback.
It is now gated to the legacy non-standalone path. Narrative instructions,
originality checks, actor personality and memory assembly are preserved.
`actor-routing-profile` remains intact for orchestration; its numerical boosts
are ignored for standalone selection. The standalone marketing lead no longer
excludes Grok by provider identity. Native server-search pricing restrictions
and video inspection constraints remain accounting/capability protections.

Standalone classification now accepts validated LLM intent/complexity/evidence
without ordinary deterministic rewriting. Safety-sensitive vision checks and
honestly labeled unavailable-classifier fallback remain. Evidence records the
actual classifier provider/model and travels to selection and reroutes.

Standalone selection receives the complete eligible inventory, registry-reported
capabilities/tiers, reviewed price sources and explicitly unknown comparative
quality/health/retry evidence. No score, family-derived specialization, actor
boost or category preference enters its prompt. Hard compatibility validation
still checks the selected candidate. One bounded, separately accounted LLM
correction is allowed for invalid selection; terminal accounting errors still
propagate. The legacy orchestration scoring/shortlisting path remains active
outside standalone scope.

## Mode and evidence contract

`routing_mode?: "best_answer" | "best_value"` is validated by the chat schema
and propagated through initial selection and refusal/error reroutes. Default:
`best_value`. Both use the same LLM and candidate inventory. `best_answer` asks
for strongest task-specific evidenced quality without price/reputation bias;
`best_value` asks for minimum total estimated cost confidently meeting quality,
with justified escalation. The preference worker must replace the explicit
request/default input with the authenticated effective persisted preference at
integration; this branch intentionally adds no persistence or UI.

Pricing is an illustrative text-only scenario: character-count/4 input, 1024
output tokens, no cache hit and one attempt, using reviewed rates and applicable
tiers. Cache rates, context/output limits and tier schedules are exposed;
media/tool/persona overhead, actual cache usage and retry probabilities are
explicitly unknown. These scenarios never authorize spending or change finance
limits. Actual serialized admission/accounting remains authoritative. Routing
stage overhead is identified separately and remains accounted as control-plane
activities; its final tokens/retries are unknown before completion.

For 1000 input and 1024 output tokens, reviewed static prices imply 17,860
microUSD for GPT-5.4 and 2,298 microUSD for GPT-5-mini, before routing overhead,
cache, retries or media. These are arithmetic scenarios, not observed savings or
quality equivalence. No historical production dataset or comparative outcome
observations were supplied, so there is no empirical before/after distribution
or quality/cost improvement claim. Mocked replay choices test authority, not
model quality. Missing comparative evidence is explicitly marked unknown.

## Validation and remaining limits

`neutral-two-stage-routing.test.ts` provides deterministic mocked replay fixtures
for simple chat, finance, implementation, memory continuation, emotional nuance,
creative writing and misleading keywords in both modes. It asserts two separate
calls, first-stage evidence provenance, all candidates visible despite shortlist
settings, absent numerical/provider boosts, and successful policy-independent
selection. Additional cases cover every provider winning, default mode,
correction/unavailable fallback, image/video eligibility, terminal accounting
failure and reviewed tiered price arithmetic. Existing creative-continuity tests
now also enforce the standalone exclusion of the legacy creative override.

Relevant suites are `neutral-two-stage-routing`, `creative-continuity`,
`google-routing`, `model-intent-routing`, `control-plane-economics`,
`standalone-model-routing`, `routing-decision-audit` and `chat-video-routing`.
Final direct execution: **173 passed, 0 failed, 0 skipped/cancelled**.
They run after `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
using `node --experimental-test-isolation=none --test` on their corresponding
`.test-dist/tests/*.test.js` files. TypeScript checks passed. The ordinary `npm test` launcher encountered
sandbox `spawnSync ... EPERM` and was interrupted; full CI is unverified. `npm run check:url` also encountered a sandbox
`spawnSync /bin/sh EPERM`. No
launcher/workflow changes were made. The workflow must perform independent CI.

Native video inspection/manual overrides retain their existing dedicated route
and authorization. Actor/persona-memory routing excerpts are bounded to 3000
characters; existing conversation compaction is 8000 characters. These excerpts
can omit relevant older detail. Registry capability metadata is not comparative
quality measurement, and unknown models/prices remain unknown. Richer quality
observations and authenticated persisted-mode integration require their owning
workers; no benchmark service, memory changes or provider integrations were added.

Changed files: `app/api/chat/route.ts`, `lib/router/master-router.ts`,
`lib/router/model-intent.ts`, `lib/router/NEUTRAL_ROUTING.md`,
`tests/creative-continuity.test.ts`, `tests/neutral-two-stage-routing.test.ts`.
The supplied `AGENT_REQUEST.md` is not an implementation change.
