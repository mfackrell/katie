# Saved-attachment decision diagnostics

The existing Gemini selector still decides which saved files to reuse. No new
relevance gate, change of source mode, rerouting, or extra paid model call is
introduced. Its existing JSON answer may now include a brief `rationale`
sentence, requested **after** deciding selections. That sentence is a model
statement of apparent relevance, *not* its private reasoning and not guaranteed
to reveal the actual internal cause of a choice.

For any nonempty attachment selection, the chat route schedules one best-effort
service-role-only insert to `public.attachment_selection_diagnostics`. The
record contains actor/chat/request identifiers, selected source IDs and mode,
candidate rank, explicit-reference flags, source availability, saved catalog
count, and the brief selector-stated rationale. It does not store raw images,
user messages, saved file summaries, complete selector prompts, or API keys.
Storage failures are logged but do not affect which files are sent.

Inspect later (privileged database access only):

```sql
select created_at, request_id, selection_method, selector_rationale,
       context_signals, selected_files
from public.attachment_selection_diagnostics
where actor_id = '<actor-uuid>' and chat_id = '<chat-uuid>'
order by created_at desc
limit 20;
```

Only future selections have these details. Existing Vercel logs recorded the
chosen files but not the selector's own rationale. Application behavior stays
as-is; requesting the optional one-line explanation changes the selector's
output instructions slightly, so the model can still make different judgments
on different runs. No independent explanation request is charged.

ITM overflow fix: if Claude returns an otherwise complete summary above 8,500
characters, the summarizer makes **one** bounded semantic compaction call
to the same model before saving a checkpoint. The prior cursor is never moved
on an incomplete, failed or out-of-budget result; the existing smaller-batch
recovery still applies. Ordinary valid summaries incur no extra provider call.
