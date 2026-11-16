# Generated-image perception and recall — engineering evidence

## Scope and baseline

Source baseline: `b01ee96944b7bef12bc30e308958267ff29ac11d` (production/main when work began).
Candidate branch: `fix/generated-image-recall-20261116`.
Isolated engineering branch: `fix/generated-image-perception-20261116`.
No production deployment, real image generation, live vision call, spending-limit change,
Supabase schema migration, or historical data rewrite is part of this change.

PR #1054 was still an unmerged draft at inspection (`acbe673d663efbd40b08090696f8fc98d9d72bf2`).
It adds an immediately preceding **user-uploaded** image correction rule and capability
control parsing. It does not register assistant-generated assets. This change uses the
same source-bound selection principle but does not merge its unrelated control parser.

## Verified root cause

`app/api/chat/route.ts` saved generated images only in assistant-message `assets`.
The catalog builder iterated message `attachments`. `saveMessage`/`encodeMessageContent`
preserved those as separate fields, and `buildMemoryContext` flattened only textual
history. A rendered asset could therefore be visible in the UI without being a retrievable
source or a source-bound Qwen observation on the next turn.

## Implemented lifecycle

1. Before publishing a generated assistant response, register each actual output via
   the existing private `katie-attachments` bucket and catalog writers.
2. Retain the original bytes at the usual `chats/{chat}/{attachment}.source` path and
   its canonical reference/descriptor at `.json`. Stable IDs bind actor, chat, assistant
   message and output index. Create-only writes plus verified byte equality make retries
   and concurrent registration idempotent. Partial catalog writes are repaired on replay.
3. Store generation provenance (request, provider, model, timestamp, original-byte SHA-256,
   output index and parents) independently from perception. Merely generating an image
   does not create a visual episode or an invented description.
4. Publish the same canonical ID/hash on the display asset and the assistant attachment.
   Existing inline display/download behavior is preserved. No new public storage route
   or bearer URL is introduced. Before publishing a checkpointed result, recheck that the
   original is still present and source-bound.
5. Resolve follow-ups by exact current-chat message and output index. Multiple outputs
   require an ordinal or a source pin. Edits follow actual parent-source lineage, not the
   global most recent image. Fresh user uploads supersede implicit generated-image recall;
   unrelated intervening conversation suppresses pronoun-only reuse.
6. A generated-image control in the existing chat UI can pin the precise output for the
   next message. It sends only message ID and asset index, not a client-supplied source URL.
7. Reopen originals through actor-bound private storage. Legacy assistant assets register
   lazily on demand; missing historical request/provider evidence is recorded as unknown,
   not invented. Only inline images and reviewed provider image hosts may be retrieved,
   with no redirects/credentials and bounded content length and timeouts.
8. Inspect on demand through the existing Qwen observation path and existing accounting
   workflow. A matching full, source-verified observation may serve an ordinary scene
   question across conversational model switches. An uncovered detail or requested
   reinspection is not replaced by an old generic summary.
9. Coordinate initial inspections using create-only source/question claims in the same
   private source directory, plus durable workflow/provider checkpoints. A concurrent
   different request cannot dispatch the same pending observation; uncertainty keeps the
   claim bound to its original workflow. Explicit reinspection is a distinct, accounted
   request, never an automatic safety-refusal bypass.
10. Persist eligible perception through existing `updateSavedImageObservation` and
    `KatieVisualEpisode` validation. Refusals remain limitations, not observations; a
    refused reinspection cannot erase a prior valid perception. Edited outputs get new
    IDs/hashes and no inherited visual description.

The existing text history and STM are unchanged. Image edits retain the reference pixels
instead of converting them into an observation-only text attachment. Both automatic and
manual compatible image-model selection preserve this edit intent.

## Authorization and failure behavior

- Existing chat/actor authentication remains the entry boundary. Source pins are resolved
  from server-read current-chat messages; actor/catalog access alone cannot cross chats.
- Private originals are hash-checked on every canonical reopen. A stored renderer has its
  own immutable digest, separate from the original-byte hash and observation hash.
- An uncertain provider call is not repeated by changing conversational providers. Only
  the owning durable request may resume a pending claim, under its existing fenced lease
  and provider accounting replay controls.
- A missing, expired or unsupported original produces a source-unavailable explanation,
  never a substitute image or a claim of pixel inspection.
- Observation/storage failures retain source identity and existing evidence. Failed
  persistence is not reported as successful retention. No signed URLs, image bytes,
  provider keys or generated-image source contents are added to logs.
- Existing conversation cleanup removes source records, claims, results and catalog entries.
- A prior generated image cannot enter unrelated requests merely because it is in the catalog.

## Verification performed by the implementation engineer

All inputs are synthetic. Real `sharp` image parsing, production storage service, source
resolver, message codec, Qwen orchestration (injected mock), and route-body code are tested.
No production credentials or paid provider calls are used.

- `npm run typecheck`: PASS.
- `tsc -p tsconfig.tests.json`: PASS.
- New generated-image lifecycle suite: 16/16 PASS; no skips/cancellations.
- Focused integrated regressions: 263/263 PASS; no skips/cancellations.
- ESLint on every changed TypeScript/TSX implementation and new test: PASS.

The same source and tests were transferred with before/after SHA-256 checks and Git blob
hash checks, then qualified on the hosted runner. Engineering run:
https://github.com/mfackrell/katie/actions/runs/43884248291

The hosted run passed typecheck, compilation, the 263 regressions, and changed-file lint.
Verified implementation commit: `213bce8259421feb6f5c1e2b200f6256bd192195`.
The delivery candidate removes temporary transfer files/workflows and adds this evidence
report and branch-only deployment exclusion; its application/test bytes are unchanged.

Integrated regressions cover direct upload, still-image observation, visual memory,
attachment continuity/discovery, real chat clarification routing, media memory, saved PDF
comparison/source scope and video timeline review. Existing assertions were retained;
isolated route fixtures explicitly model absence of the new source-resolution stage.

Additional negative cases verify malformed/untrusted URLs, cross-actor/cross-chat access,
original deletion, renderer corruption, uncertainty replay, catalog-write interruption,
policy refusals, new-question coverage, and edits without an unnecessary observation call.
A route-body regression verifies observation uses the trusted workflow request ID before
the later chat request receipt is initialized.

### Known baseline qualification blocker

Full `npm run lint` fails locally on three **unchanged, tracked baseline** declarations:
- `lib/projects/resource-economics.d.mts`: three `no-explicit-any` errors.
- `lib/projects/resource-forecast.d.mts`: one `no-explicit-any` error.
- `lib/projects/specialist-resource-plan.d.mts`: five `no-explicit-any` errors.

The existing `components/chat-workspace.tsx` hook-dependency warning is also unchanged.
These Developer Orchestrator files are outside the authorized scope. They have not been
edited, ignored, or weakened to make this image patch pass. Full hosted CI must establish
its own result; targeted passes are not a claim that the entire repository is green.

## Release and independent review status

This report is engineering evidence, **not an independent review verdict**. Independent
security/accounting review and Mark's production authorization remain required. No
independent reviewer is impersonated and no paid review agent was dispatched.
Both branches are explicitly disabled for Vercel deployments during engineering.

## Migration and rollback

No SQL migration. Records are additive objects/descriptor fields in the existing private
bucket and existing message JSON. No historical messages are rewritten for lazy legacy
registration. To roll back, revert the application changes; existing display assets remain
readable by earlier code. Do not delete retained originals or visual history during rollback.
New catalog/source records can remain private and are covered by existing conversation
cleanup. A rollback must not release uncertain accounting exposure or replay paid work.
