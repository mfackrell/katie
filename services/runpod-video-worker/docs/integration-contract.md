# Future Katie integration contract (documentation only)

Nothing in this document is deployed or applied to Katie.

## Existing Katie facts inspected 2026-10-09

- Video uploads: `app/api/upload/complete/route.ts`, `lib/uploads/stored-uploads.ts`.
- Private bucket: `katie-attachments`. Original video is stored under `chats/<chat-id>/<attachment-id>.source` when persisted to the conversation.
- Current video model routing: `lib/chat/video-routing.ts` directs direct video input to Google; `app/api/chat/route.ts` falls back to four sampled FFmpeg frames sent to Grok.
- Current memory: `public.messages`, `short_term_memory`, `intermediate_memory`, `long_term_memory`.

## Contract

The independent worker accepts a signed URL to a private Supabase video, an attachment ID, and optional analysis parameters. The worker returns a `schema_version: "1.0"` result with timestamped segments and a text summary. It never handles actor prompts or chat history. It never receives a Supabase service-role key.

A later Katie integration would:

1. Confirm the deployed infrastructure and intended material fall within the account’s written authorization. A model policy block must NOT be automatically rerouted to this worker as a bypass.
2. Store a durable `video_analysis_jobs` row scoped by actor/chat/attachment ID, keyed idempotently by source hash and model/parameter version.
3. Generate short-lived download URLs on a protected server route. Protect/rotate credentials, account for worker cold-start time, and never return signing keys to the browser.
4. Submit `input` via RunPod Serverless `/run` asynchronously; keep the job ID and status. Do not hold an open Vercel chat response for analysis.
5. Poll `/status` from a trusted backend or use an authenticated callback; compare response `attachment_id`, source hash, and model version; reject stale/duplicate responses.
6. Store the structured response separately from chat text, with a status flag distinguishing source observations from unsupported inference. Use appropriate actor-scoped RLS and private retention policies.
7. Supply the stored analysis to the model selected for the subsequent chat turn. Do not force Google routing merely because a historical video is present.
8. Support targeted reanalysis of selected timestamps or segments only when the user requests it.
9. Expose honest progress and failures in UI; cleanup orphaned jobs and timeout `processing` states.
10. Provide a path for deleting original media and all analysis-derived records.

## Security and operational caveats

- Never disclose signed URLs in logs or LLM prompts; prefer short-lived credentials.
- The standalone worker has no adult-specific filter or `content_policy_confirmed` gate. Account authorization, source ownership, and legal compliance must be managed outside the worker; do not infer age or consent from video appearance.
- No broad network access or arbitrary URL download is permitted by the worker.
- RunPod queue job may report COMPLETED even when the worker returns `status: rejected` or `failed`; check both layers.
- Signed URL TTL must encompass queued time, cold startup and download time. Avoid unnecessarily long TTLs; rotating/revoking tokens may require storage deletion or administrative procedures.
- Benchmark GPU RAM and throughput with authorized sample clips before estimating production cost.
