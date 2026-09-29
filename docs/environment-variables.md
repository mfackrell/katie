# Environment Variables

This list is derived from variables referenced in code.

## Supabase / persistence
- `NEXT_PUBLIC_SUPABASE_URL` (**required**)  
  Supabase project URL used by server-side PostgREST client and browser config helpers.
- `SUPABASE_SERVICE_ROLE_KEY` (**required**)  
  Server-side key used for durable reads/writes in `lib/data/supabase/admin.ts`.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (**optional, required only if browser client config is used**)  
  Read by `lib/data/supabase/browser.ts`.

## Provider API keys
At least one of the following provider families must be configured for chat generation.

- `OPENAI_API_KEY` (optional, provider-specific)
- `GOOGLE_API_KEY` (optional, provider-specific)
- `GROK_API_KEY` (optional, provider-specific)
- `XAI_API_KEY` (optional alias for Grok)
- `grok_api_key` (optional lowercase alias for Grok)
- `CLAUDE_API_KEY` (optional, provider-specific)
- `claude_api_key` (optional lowercase alias for Claude)

## App behavior
- `ASSISTANT_NAME` (optional)  
  Overrides assistant display/prompt identity name; defaults to `Katie`.
- `RETRY_ON_PROVIDER_REFUSAL` (optional)  
  Controls refusal retry behavior in router refusal handling.
- `INTERNAL_API_TOKEN` (optional but required to call internal refresh endpoint)  
  Shared secret for `POST /api/internal/model-registry/refresh` via `x-internal-token` header.

## Router diagnostics and policy
- `ROUTER_TRACE_ENABLED` (optional)  
  Enables routing trace output.
- `ROUTER_POLICY_VERSION` (optional)  
  Metadata tag included in routing trace.
- `ROUTER_SCORING_POLICY_VERSION` (optional)  
  Metadata tag included in routing trace.
- `ROUTER_POLICY_ENGINE_ENABLED` (optional)  
  Enables policy-engine-based selection path.
- `ROUTER_POLICY_SHADOW_MODE` (optional)  
  Runs policy in shadow mode while keeping baseline selection live.
- `ROUTER_POLICY_FALLBACK_ON_MISSING_METADATA` (optional)  
  Defaults to fallback behavior unless explicitly `false`.
- `ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST` (optional)  
  Numeric hard-cap used by policy engine.
- `ROUTER_POLICY_MAX_COST_MULTIPLIER_VS_CHEAPEST` (optional)  
  Numeric policy threshold for cost multiplier.

## Safe example values
```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

OPENAI_API_KEY=your_openai_key
GOOGLE_API_KEY=your_google_key
GROK_API_KEY=your_grok_key
CLAUDE_API_KEY=your_claude_key

ASSISTANT_NAME=Katie
RETRY_ON_PROVIDER_REFUSAL=true
ROUTER_TRACE_ENABLED=false
ROUTER_POLICY_ENGINE_ENABLED=false
```


## Adaptive multi-model collaboration

- `KATIE_COLLABORATION_ENABLED` (optional, default: `true`)  
  Set to `false` to disable model-requested collaboration globally.
- `KATIE_COLLAB_MAX_DELEGATIONS` (optional, default: `5`, range: 1-12)  
  Maximum total helper requests during one user turn, including nested helper requests.
- `KATIE_COLLAB_MAX_DEPTH` (optional, default: `2`, range: 0-4)  
  Maximum recursive helper depth. Depth 0 prevents helpers from requesting other helpers.
- `KATIE_COLLAB_MAX_CONTRIBUTION_CHARS` (optional, default: `12000`)  
  Maximum retained text from one helper contribution.
- `KATIE_COLLAB_MAX_TOTAL_CONTRIBUTION_CHARS` (optional, default: `48000`)  
  Maximum retained helper evidence across the whole collaborative turn.
- `KATIE_COLLAB_PARTICIPANT_TIMEOUT_MS` (optional, default: `120000`)  
  Per-model timeout for collaboration control/helper passes.
- `KATIE_COLLAB_MAX_TOTAL_DURATION_MS` (optional, default: `240000`, hard max: `280000`)  
  Global wall-clock budget for one collaborative turn. Katie reserves part of this window for the final synthesis so helper work cannot consume the full serverless request lifetime.

Collaboration activates automatically for high-complexity requests and selected medium-complexity technical/research intents. Users can explicitly request it with phrases such as "work together", "ask another model", "multi-model", "council", or "deep review". Manual provider/model overrides remain single-model unless the user explicitly requests collaboration.
