# Adaptive Multi-Model Collaboration

Katie can dynamically consult other AI models during a task. Collaboration is not a fixed panel, majority vote, or preassigned provider sequence. The currently selected lead model decides whether outside help would materially improve its answer and requests a helper for a specific capability.

## Goals

- Preserve Katie as one persistent persona with one canonical memory/context layer.
- Keep simple requests fast and single-model.
- Let a lead model request specialist help only when useful.
- Allow a helper to request a narrower helper when the subproblem genuinely benefits from it.
- Prefer model/provider diversity without hardcoding provider pairs.
- Return one synthesized Katie answer to the user.
- Keep private reasoning/control traffic internal.
- Bound latency, spend, recursion, and accumulated context.
- Fail gracefully if a helper or provider is unavailable.
- Preserve existing provider refusal/fallback behavior.

## Lifecycle

1. The existing master router selects the lead provider/model.
2. Katie decides whether collaboration is eligible for this turn.
3. If collaboration is inactive, the normal generation path is unchanged.
4. If collaboration is active, the lead receives an internal control pass.
5. The lead may:
   - request one helper for a specific task/capability, or
   - declare that it has enough information for final synthesis.
6. Katie routes the requested helper through the existing model router.
7. The helper receives the same actor persona, canonical memory/context, relevant attachments/repository context, and the lead's precise subproblem.
8. The helper may:
   - answer the subproblem, or
   - request one narrower helper, subject to global depth/delegation budgets.
9. The result returns to the requesting model.
10. The lead can request another helper or proceed.
11. The original lead model performs the final user-facing synthesis.
12. Only the final synthesis is streamed as answer text. Internal collaboration control passes are not exposed as chain-of-thought.

## Dynamic routing

A model asks for a capability, not a hardcoded vendor. Supported capability labels are:

- analysis
- verification
- critique
- coding
- debugging
- architecture
- research
- writing
- math
- vision
- other

Katie maps the requested capability to the existing routing intents and reuses the normal model registry/routing stack.

Katie prefers a provider different from the requester to gain independent perspective. If cross-provider diversity is unavailable, it may select a different model from the same provider. An exact participant already used during the turn is excluded from future helper selection.

Visual/video constraints from the original request are preserved when routing helpers.

## Activation

Collaboration is automatically eligible for:

- high-complexity requests;
- selected medium-complexity technical, architecture, coding, research, and multimodal requests;
- sufficiently substantial requests in those domains.

Users can explicitly request collaboration with language such as:

- "work together"
- "ask another model"
- "multi-model"
- "council this"
- "deep review"
- "second opinion"
- "adversarial review"

A manual provider/model override remains single-model unless the user explicitly asks for collaboration.

Image-generation requests do not enter this text collaboration path.

## Safety, latency, and cost limits

Environment-configurable limits:

- `KATIE_COLLABORATION_ENABLED` — default `true`
- `KATIE_COLLAB_MAX_DELEGATIONS` — default `5`, hard range 1-12
- `KATIE_COLLAB_MAX_DEPTH` — default `2`, hard range 0-4
- `KATIE_COLLAB_MAX_CONTRIBUTION_CHARS` — default 12,000 characters
- `KATIE_COLLAB_MAX_TOTAL_CONTRIBUTION_CHARS` — default 48,000 characters
- `KATIE_COLLAB_PARTICIPANT_TIMEOUT_MS` — default 120 seconds per control/helper call
- `KATIE_COLLAB_MAX_TOTAL_DURATION_MS` — default 770 seconds, hard max 770 seconds

Katie reserves two 180-second final-answer windows plus 15 seconds for replacement routing. Research receives up to 180 seconds and other helpers receive up to 120 seconds per call. A helper is only started when its full window remains; optional lead control also needs a full 120-second window. Failed helpers can retry another eligible model when a full helper window remains. Final-answer failures preserve completed evidence and select a backup only when at least 195 seconds remain. All outer reroutes share one absolute request deadline, capped 30 seconds before the 800-second server limit; rerouting cannot reset the clock. These are maximum allowances, not required waits.

The limits are global to a user turn, including nested helper requests. A helper cannot create an unbounded model-to-model loop.

## Failure behavior

Helper failures are advisory failures, not chat failures.

If a helper:

- times out,
- has no eligible model,
- returns an invalid or empty control payload,
- hits a provider error,

Katie records the failure and automatically reroutes the same delegated task to another eligible model when time and candidate budget remain. The failed model is excluded from the retry. This retry occurs inside the delegation itself, so Katie does not waste an extra lead-model control pass merely asking for the same work again.

If no replacement is available, or the remaining collaboration time is reserved for final synthesis, control returns to the requester and the lead continues with the evidence already collected.

If the lead provider itself fails, the existing provider refusal/error fallback path remains authoritative.

Unstructured helper text is treated as an advisory answer with a caveat rather than destroying the entire turn. Unstructured lead control output is treated as a preliminary synthesis brief and Katie proceeds to the final synthesis pass.

## Runtime identity

Each collaborator receives a fresh `KATIE_RUNTIME_CONTEXT` matching its actual provider/model. A helper must never inherit the lead model's runtime identity.

All underlying models still operate as Katie. Provider/model identity is orchestration metadata rather than a separate user-facing persona.

## User interface

The UI shows user-safe collaboration progress in the Thinking panel and the main loading state. It includes:

- the selected lead model;
- when the lead requests another model and the requested capability;
- the helper model Katie selected;
- successful helper completion and elapsed time;
- helper failure in sanitized language;
- automatic replacement-model retries;
- collaboration/time-budget decisions;
- when the lead has enough evidence;
- when final synthesis begins;
- final delegation count, contributors, and collaboration duration.

The send button changes from Routing to Collaborating or Synthesizing as the request progresses, and the normal loading message shows the current collaboration status instead of a generic model-is-thinking message.

The UI does not expose hidden chain-of-thought, internal control JSON, raw provider error payloads, or private reasoning.

## Observability

Every collaboration trace event contains the top-level chat request ID. Server logs record:

- collaboration start/completion;
- requester/helper provider/model;
- requested capability;
- delegation index and depth;
- helper completion/failure;
- participant duration;
- budget/depth limit events;
- final contributor/delegation metadata.

This allows one Vercel request ID to reconstruct the collaboration graph.

## Testing

### Deterministic tests

`tests/collaboration.test.ts` covers:

- protocol parsing;
- automatic/explicit activation;
- lead-requested helper delegation;
- recursive helper-requested delegation;
- helper failure recovery;
- hard delegation limits;
- automatic helper failure rerouting;
- the no-helper/direct path.

These tests use fake providers and make no paid API requests.

### Production deterministic health check

`GET /api/health/collaboration` executes deterministic collaboration in the deployed Next.js runtime and validates:

1. lead -> helper -> final synthesis;
2. lead -> helper -> nested helper -> final synthesis;
3. delegation-budget enforcement.

It uses fake providers and does not expose secrets or make external model calls.

### Live provider validation

For real-provider validation, send a deliberately complex request containing an explicit collaboration phrase (for example, "Have the models work together and adversarially review this architecture"). Then inspect Vercel logs for the request ID and confirm the expected collaboration trace:

`collaboration_started -> delegation_requested -> helper_selected -> helper_completed -> ... -> final_synthesis_started -> collaboration_completed`.

The specific number of helpers is intentionally not predetermined. The lead model owns that decision subject to Katie's hard limits.

## Follow-ups and visible failures

A marketing classification alone does not trigger a website inspection from a historical URL. Package design, positioning, and copy follow-ups use saved inspection context; an explicit site review or a new current-message site target can still trigger retrieval.

Known music, speech-only, transcription, embedding, moderation, and video-generation model families are excluded from conversational routing even if discovery labels them text-capable. If no compatible model remains, routing reports failure rather than choosing an incompatible model.

Terminal chat failures are saved as assistant messages and linked to the failed request. The server sends the error event and closes the stream normally so queued error events are delivered. Reconnection and refresh retain the failure message; the UI uses its saved ID to avoid duplicates.

## Universal completion standard

Every actor receives the same completion standard through assembled context. Collaboration helpers check the latest request, constraints, completeness, internal consistency, evidence and usability, and contribute concrete corrections or draft components. Lead control and final synthesis carry the same standard; final synthesis incorporates supported corrections and performs its own completion check even without a successful reviewer. This does not add an extra model call or require collaboration for simple requests. Pure research helpers remain focused on factual retrieval.

Missing business facts are not invented. Katie finishes supported portions, distinguishes proposed terms from established facts, and identifies only material open decisions. Assessment-only and brainstorming requests keep their requested scope. This is a shared instruction standard, not a guarantee that model output is error-free.
