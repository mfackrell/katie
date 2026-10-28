# Standalone paid call coverage

This is a source audit of `lib/`, `app/`, `apps/`, `packages/`, and `scripts/`. It distinguishes actual provider transmission boundaries from callers that use an already guarded adapter. No live provider request, production change, deployment, or migration was used to establish this inventory.

The standalone boundary is `lib/standalone-accounting/dispatch.ts:createAccountingFetch`. For chargeable supported requests it requires a trusted server accounting context, immutable prepared payload, supported versioned pricing, durable attempt admission, exact dispatch claim, and reconciliation. Missing context or configuration blocks transmission. Unsupported billing dimensions and endpoints block transmission. A response without a supported complete provider receipt retains uncertain exposure and stops automatic continuation. GET/HEAD discovery and the explicitly identified token-count endpoints are passed through separately.

`lib/standalone-accounting/workflow.ts:executeStandaloneWorkflow` authenticates the owner and actor/chat binding, saves original input, fences execution with a durable lease, and replays the original provider response checkpoints. `lib/standalone-accounting/context.ts` keeps nested activity labels on the same parent attempt ordinal. This audit does not equate an in-memory UI status or model output with a billing receipt.

## Status meanings

| Status | Meaning |
| --- | --- |
| Guarded | Actual inference transport uses the durable standalone boundary; supported requests can run only through its admission and approval rules. |
| Blocked | The path throws before chargeable transmission because its billing is unsupported, or because it lacks an authorized standalone context. |
| Excluded Developer Orchestrator | A distinct mission/development/benchmark accounting path outside this standalone milestone. Its existing budgets have not been changed. |
| Unguarded | An actual SDK or direct HTTP transmission can avoid the standalone boundary. Reachability is stated separately. |
| Non-inference infrastructure | Discovery, authentication, existing-job polling, storage, source retrieval, or deployment infrastructure; not represented as a supported standalone inference charge. |

## Actual model-provider transport boundaries

| Provider / operation | Exact implementation files | Status and evidence |
| --- | --- | --- |
| OpenAI text, Responses, Chat Completions, streaming | `lib/providers/openai-provider.ts` | **Guarded.** SDK has `maxRetries: 0` and `fetch: createAccountingFetch("openai")`; all `chat.completions.create` and `responses.create` calls use that client. |
| OpenAI legacy Completions | `lib/providers/openai-provider.ts:generateViaLegacyCompletions` | **Blocked for unsupported endpoint billing.** `client.completions.create` uses the same guarded SDK transport; `/v1/completions` is not in the supported estimator endpoint allowlist. |
| Anthropic text and streaming | `lib/providers/claude-provider.ts` | **Guarded.** `/v1/messages` POST uses `createAccountingFetch("anthropic")`; model-list GET is discovery. |
| Google text, native images, multimodal, streaming | `lib/providers/google-provider.ts`, `lib/providers/google-transport.ts` | **Guarded.** Generation uses `googleGenerateContent` / `googleGenerateContentStream`, whose serialized REST POST uses `createAccountingFetch("google")`. The remaining Google SDK client is used for model-list discovery. Unsupported image-generation/file/audio/video billing is blocked by estimation rather than assumed free. |
| Grok Chat Completions, Responses/search, streaming | `lib/providers/grok-provider.ts` | **Guarded.** SDK uses `maxRetries: 0` and accounting fetch; direct Responses POSTs also use accounting fetch. |
| Grok image generation/edit | `lib/providers/grok-provider.ts` | **Blocked for unsupported billing.** `/v1/images/*` POSTs use accounting fetch, whose estimator does not admit those endpoints/dimensions. They cannot fall through to an unguarded image POST. |
| Native tool turns for OpenAI, Anthropic, Google, Grok | `lib/providers/native-tools.ts` | **Guarded.** Final serialized POST uses `createAccountingFetch(provider)`. Unsupported server-side tools/billing dimensions fail admission. |
| Direct actor-memory calibration | `app/api/actors/route.ts:calibrationPreview` | **Guarded; blocked without an authorized context.** The audit found a bare SDK bypass and reported it. The reviewed constructor now uses `maxRetries: 0` and `createActivityAccountingFetch("openai", "actor-calibration")`; `chat.completions.create` therefore cannot bypass admission. |
| Reusable OpenAI embeddings implementation | `packages/indexer/src/embeddings.ts:OpenAIEmbeddingProvider` | **Blocked explicitly** by `blockUnaccountedPaidDispatch("Indexer embeddings")` before `embeddings.create`; SDK retries are also disabled. The audit reported the original bare SDK path. No runtime instantiation of this class was found beyond its definition/export; `packages/indexer/src/pipeline.ts` accepts an injected embedder. |

## Automatic and indirect inference callers

These callers do not create a separate paid transport. Their provider calls inherit the preceding transport boundary. Outside an authorized context they block, even if the caller catches the resulting error and returns a neutral or unavailable result.

| Activity | Exact implementation files | Status / containment |
| --- | --- | --- |
| Primary standalone chat, direct generation, retries, repairs, revisions | `app/api/chat/route.ts` | **Guarded.** Standalone requests enter the durable workflow and call guarded provider adapters. Accounting errors stop outer retry/fallback handling. Managed/executive requests select the explicit Orchestrator scope. |
| Intent classification, routing rerank, project resolution | `lib/router/model-intent.ts`, `lib/router/master-router.ts`, `lib/router/refusal-detection.ts` | **Guarded.** Actual generation is through provider adapters, labeled `control_plane_*`. Accounting errors are terminal. Local timeouts request cancellation and stop automatic fallback. |
| Actor routing-profile generation | `lib/router/actor-routing-profile.ts`, `app/api/actors/route.ts:buildActorRoutingProfile` | **Blocked without an authorized context.** Uses guarded provider adapters. This is separate from the calibration SDK bypass above. |
| Adaptive collaboration lead control, helpers, research, synthesis | `lib/collaboration/orchestrator.ts`, `lib/collaboration/routing.ts` | **Guarded.** Activity labels identify each transmission. Premium automatic helpers are filtered from discovery/snapshots and checked again before invocation. Timeout or accounting uncertainty is terminal. |
| Capability lead, helper/research, finalization | `lib/collaboration/capability-escalation.ts`, `lib/collaboration/capability-escalation-runner.ts` | **Guarded.** All lead/helper/finalization provider calls are activity-labeled; injected premium helpers are rejected before dispatch. |
| Independent assessment, contract validation, comparison, revision, final validation | `lib/collaboration/required-review.ts` | **Guarded.** Each stage has a `required_review_*` activity. Accounting denial cannot become another reviewer attempt or a successful review result. Expired execution budgets do not start generation. |
| Shared automatic-use and timeout policy | `lib/collaboration/attempt-policy.ts` | **Containment.** Recognizes dated/namespaced premium aliases; preserves deliberate lead selection. Cancels timed-out work, reports billing outcome unknown, and stops paid fallback even if the provider ignores cancellation. Cancellation alone is not proof billing stopped. |
| Native self-inspection tool loop | `lib/tools/loop.ts` | **Guarded.** Calls adapter `generateToolTurn`, whose actual native HTTP request uses accounting fetch. |
| Chunked document passes | `lib/providers/chunked-document-workflow.ts` | **Guarded.** Every pass calls the guarded provider; each real transmission is a separate parent workflow attempt. |
| Historical visual continuity and video reply synthesis | `lib/chat/visual-continuity.ts`, `lib/chat/video-response.ts`, `lib/runpod/video-conversation.ts`, `lib/runpod/video-orchestration.ts` | **Guarded or blocked without context.** Text/vision synthesis uses guarded provider adapters, including the explicitly constructed Grok adapter. RunPod submissions are separately blocked below. |
| Video timeline frame analysis | `lib/video-timeline/service.ts` | **Guarded.** Bounded frame observations use a guarded provider. Local FFmpeg/frame decoding does not itself invoke a model API. |
| Quarantined-model health verification | `lib/models/registry.ts`, `app/api/internal/model-registry/refresh/route.ts`, `scripts/model-registry-worker.mjs` | **Blocked without an authorized context.** Model discovery is GET; optional native-tool/text verification uses guarded adapters. The internal token/cron authorization does not itself create standalone spend authorization. |
| Provider-backed local evaluation harnesses | `scripts/evaluate-objective-first.mjs`, `scripts/evaluate-objective-first-review.mjs` | **Guarded when using the current compiled adapters; blocked without context.** The review harness can load a baseline checkout, whose older implementation is outside this working-tree guarantee. No evaluation was run for this audit. |

## Memory, recovery, and attachment inference

| Activity | Exact implementation files | Status / actual boundary |
| --- | --- | --- |
| Explicit fact extraction | `lib/memory/explicit-fact-extractor.ts` | **Guarded.** OpenAI SDK uses `maxRetries: 0`, `createActivityAccountingFetch("openai", "memory-extraction")`. |
| Conversation summary | `lib/memory/summarizer.ts` | **Guarded.** Anthropic-compatible SDK transport uses `maxRetries: 0`, activity `memory-summary`. |
| Long-term edit, pruning, fact amendment, repair | `lib/memory/claude-memory-client.ts`, `lib/memory/long-term-editor.ts` | **Guarded.** Editor calls the accounting-backed Claude-compatible facade with activity `memory-edit`. |
| Memory maintenance and its review | `lib/memory/long-term-maintenance.ts`, `lib/memory/hygiene.ts`, `app/api/chat/route.ts` | **Guarded.** Actual SDK requests use activity `memory-maintenance`; standalone work must execute in its originating durable workflow rather than become unscoped background inference. Missing scope blocks at transport. |
| Recovery diagnosis | `lib/recovery/diagnose.ts`, `lib/recovery/worker.ts` | **Guarded or blocked without context.** OpenAI Responses uses zero SDK retries and activity `recovery-diagnosis`. A worker without standalone scope cannot transmit through that client. Existing development execution remains separately excluded. |
| Attachment selection | `lib/chat/attachment-selection.ts` | **Guarded.** Uses accounting-backed `googleGenerateContent`; currently inherits the enclosing accounting activity. |
| Attachment observation | `lib/uploads/attachment-observations.ts` | **Guarded.** Uses accounting-backed Google REST generation; currently inherits the enclosing accounting activity. |
| PDF page evidence | `lib/uploads/pdf-evidence.ts` | **Guarded.** Uses accounting-backed Google REST generation; currently inherits the enclosing accounting activity; unsupported document billing blocks rather than using a guessed amount. |

## Uploads, storage, and RunPod

| Operation | Exact implementation files | Status / limitation |
| --- | --- | --- |
| OpenAI native file upload | `lib/uploads/build-file-references.ts:uploadToOpenAi` | **Blocked.** SDK file creation uses accounting fetch, but multipart upload is not supported JSON inference and is rejected before transmission. File storage, file-search/vector-store, and upload charges have no estimator in this milestone. |
| Google native file upload / storage / processing | `lib/uploads/build-file-references.ts:uploadToGoogle` | **Blocked explicitly** by `blockUnaccountedPaidDispatch("Google file upload and storage")` before constructing the SDK uploader. This was a reachable bare-SDK bypass from `app/api/upload/route.ts` when first audited and has been closed in the reviewed source. |
| Google file-state polling | `lib/uploads/build-file-references.ts:waitForGoogleVideoFileActive` | **Non-inference infrastructure.** Existing-file GET only; new Google upload is blocked above. No storage or processing charge is estimated by this GET. |
| RunPod generated image | `lib/chat/runpod-image-fallback.ts:generateRunpodImage` | **Blocked explicitly** before `/runsync` POST. Image retrieval and existing-job polling are separate non-submission operations. |
| RunPod still-image analysis | `lib/chat/runpod-still-vision.ts:describeImageWithRunpodQwen` | **Blocked explicitly** before `/run` POST. No reservation is inferred from a local timeout or queue state. |
| RunPod durable video submission | `lib/runpod/durable-results.ts:submitSavedVideo`, `app/api/internal/runpod-results/submit/route.ts`, `lib/runpod/synthetic-validation.ts`, `scripts/runpod-synthetic-operator.mjs` | **Blocked explicitly** before `/run` POST. Existing durable receipt creation is not permission to incur a provider charge. |
| RunPod video fallback / synthesis / status reconciliation | `lib/chat/runpod-video-fallback.ts`, `lib/runpod/video-conversation.ts`, `lib/runpod/video-orchestration.ts`, `lib/runpod/durable-results.ts` | **Blocked at new submission; existing-job GET polling remains.** Provider text synthesis uses the guarded adapters described above. GPU execution pricing/receipts are unsupported by this standalone ledger. |
| Private file ingestion, signed URLs, blob storage | `app/api/upload/route.ts`, `app/api/upload/chunk/route.ts`, `lib/uploads/stored-uploads.ts`, `lib/uploads/video-handoffs.ts`, `scripts/video-upload-production-smoke.mjs` | **Non-inference infrastructure.** These can use Supabase/private storage. Database, storage, network egress, and hosting charges are not measured or claimed as covered by the model-provider attempt ledger. The production smoke script was not run. |

## Excluded Developer Orchestrator and benchmark paths

| Operation | Exact implementation files | Why excluded |
| --- | --- | --- |
| Mission planning, routing, generation, native tools, counting | `lib/orchestration/bounded-provider.ts`, `lib/orchestration/routing.ts`, `lib/missions/model.ts`, `lib/executive/planner.ts` | **Excluded Developer Orchestrator.** Uses the existing mission accounting/reservation flow and bounded provider client, including its direct Anthropic/Google POSTs and OpenAI/Grok SDK client. These transports are not described as standalone guarded. |
| Owner-authorized development issue/workflow execution | `lib/agents/development.ts` | **Excluded Developer Orchestrator.** GitHub workflow handoff and development receipts are not a standalone chat model transmission. Existing budgets and owner approval requirements are unchanged. |
| Trusted native benchmark upstream and receipt writer | `scripts/benchmark/native-provider-receipts.mjs`, `scripts/benchmark/native-development-host.mjs`, `scripts/benchmark/paid-staging-nonfull-runner.mjs`, `scripts/benchmark/nonfull-trusted-grant.mjs` | **Excluded development/benchmark accounting.** Raw OpenAI Responses POST is intentional within the existing benchmark gateway and canonical receipt flow, not an unguarded standalone chat transport. No benchmark was run. |
| Trusted accounting scope selection | `app/api/chat/route.ts`, `lib/standalone-accounting/context.ts` | Executive/managed execution selects explicit Orchestrator scope. Nested helpers of a standalone request cannot opt out of standalone accounting merely by entering an Orchestrator wrapper. |

## Other direct HTTP calls

The audit also inspected direct fetch sites rather than treating every HTTP request as model inference. Provider model-list GETs, explicit token-count endpoints, public pricing-catalog retrieval (`lib/models/registry.ts`), Supabase authentication (`lib/standalone-accounting/auth.ts`, `lib/tools/authorization.ts`), GitHub metadata/tools/development calls (`app/api/chat/route.ts`, `lib/tools/self-inspection.ts`, `lib/agents/development.ts`), and local browser/smoke scripts do not create a new supported inference dispatch. Public web/browser retrieval in `lib/research/` is source inspection, not a hidden SDK model client. Infrastructure billing remains outside the model receipt totals.

## Development cost visibility

The repository's standalone ledger records application provider attempts admitted through its transport boundary. It does **not** supply provider billing receipts for the implementation agents working on this change. Agent token counters, elapsed time, test counts, and coding-tool activity are not sufficient to establish a dollar cost. No implementation-agent dollar amount is estimated or asserted here. That cost requires the relevant provider/account billing records or authoritative host receipts, which are unavailable in this development session.

## Remaining review items

1. The audit identified three bypasses: direct actor calibration, Google file upload/storage, and latent indexer embeddings. All three now have guards or explicit pre-dispatch blocks in the reviewed working tree. No additional unguarded standalone model/provider dispatch was found by this static audit.
2. Unsupported upload/storage/image/video/GPU operations must remain blocked until immutable billing assumptions and exact-attempt approval/reconciliation are implemented for them.
3. Any future SDK client or direct provider POST must either use the standalone boundary, have an explicit pre-dispatch block, or belong to a documented independent Orchestrator/benchmark ledger. Merely having an API key, an authenticated route, a model registry price, or a usage counter is not spend admission.
