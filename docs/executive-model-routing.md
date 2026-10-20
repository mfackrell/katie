# Executive and specialist model routing

The Executive is management-only. Neither management planning nor a mission-backed specialist may choose a fixed provider or worker model by role. Every planning, analysis, research, composition, revision and independent review stage passes its actual objective and scoped instructions to Katie's shared task router. Factory-created specialists inherit this runtime policy, including their later assignments and subordinate missions.

## Execution contract

- Use the active model registry and shared provider health. Select an eligible model/submodel for the particular task; prioritize substantive review quality.
- Retain the chosen model and order fallback candidates across providers before additional models from the same provider. Billing, authentication and rate-limit failures skip that provider for the remaining attempt chain.
- Persist actual execution provider, model, selection reason and attempted models with the assignment result. Each native call records the provider/model in the durable call ledger.
- Keep the same mission, job, lease, tool permissions and token allowance during fallback. No SDK retries, automatic chat continuations, ordinary-chat fallback, budget bypass or false completion.
- Validate context before inference. Reserve every routing and execution inference before dispatch. Routing calls have a separate limit of three times the mission's worker-call allowance, but consume the same mission and project token budgets. Existing uncertain charges remain reserved.
- Preserve the independent review and specification-repair contracts. Malformed deliverables and tool evidence trigger the established correction/blocking paths; provider fallback does not silently approve them.

Bounded transports support OpenAI and xAI Responses, Anthropic Messages, and Gemini generateContent. Anthropic and Gemini retain native calculator continuation context and execute only the deterministic allowlisted calculator. Research requires native cited search evidence. Gemini native search is currently excluded from mission research because this adapter cannot enforce the mission's hard search-use cap. Its eligible text and calculator tasks remain routable. This is a tool-budget limitation, not an OpenAI preference.

## Release requirements

Apply the routing-budget migration before deploying the runtime. Do not merge or release merely because a preview builds. The PostgreSQL fencing/budget tests, strict CI, existing independent review checks and live-provider acceptance must pass.

Live acceptance must prove task-specific choices on real EO/child assignments and a provider outage with preserved mission identity, prior charges, tool receipts and final reviewed delivery. Offline simulated transports prove control flow, not live provider compatibility or production acceptance.
