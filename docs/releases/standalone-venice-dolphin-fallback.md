# Independent Dolphin Venice 1.2 still-image fallback

Qwen3-VL-8B-Instruct on RunPod remains Katie's primary still-image observer. Dolphin
Venice 1.2 is called only after Qwen provides unavailable or insufficient
visual evidence (including sparse focal-point detail). Sufficient Qwen
descriptions never invoke Venice. The existing premium image escalation stays
available if neither observer provides usable evidence.

## Secure server-side setup

Configure VENICE_API_KEY in Katie's production Vercel environment. Do not put
the key in the repository, a NEXT_PUBLIC_ variable, chat, logs or browser storage.
A key created in the Venice website is not automatically connected to Vercel.

Without VENICE_API_KEY, the existing Qwen pipeline stays unchanged. A key with
no Venice credits may receive a definitive 402; do not retry it.

## Bounds and spending

- Pinned model: venice-uncensored-1-2
- Pinned endpoint: https://api.venice.ai/api/v1/chat/completions
- One inline JPEG/PNG/WebP image, up to 8,000,000 URL characters
- Same approved Qwen focal-point prompt, plus user's actual question, up to
  8,192 characters combined
- Output generation limit: 4,096 tokens; retained description: 20,000 chars
- No provider-side web search, fallback models, tools or storage
- Free model catalog preflight verifies private vision capability and rates
  no higher than $0.20/M input and $0.90/M output
- Separate, conservative $0.10 per-call exposure reservation in Katie's
  existing authenticated owner/request ledger; this is not an exact bill.
  Existing $0.50 per-call and $2.00 cumulative approval thresholds apply.
- A single POST after atomic authorization; no retry on lost outcomes. Exact
  results and definitive rejections are durably checkpointed. Uncertain
  responses retain full reserved exposure and prohibit automatic re-dispatch.

## Migration and verification

Additive migration:
supabase/migrations/20261030230000_venice_dolphin_vision_fallback.sql

Apply through the existing migrations workflow on main; do not run manually.

Tests:
- tests/venice-still-vision.test.ts (mocked transport and ledger)
- tests/venice-dolphin-postgres.test.mjs (isolated real PostgreSQL)
- Existing Qwen and standalone accounting tests remain unchanged.

No paid live inference is performed in CI. A live quality comparison requires
a configured key and available account credits. This integration changes no
image generation, videos, general chat routing or Developer Orchestrator.
