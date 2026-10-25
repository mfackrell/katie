# Adaptive response composition — live acceptance

This is an **opt-in, billable, authenticated** acceptance exercise for PR #758. It uses the existing production-compatible chat UI. It does not bypass authentication or create actors, chats, or credentials.

## Preconditions

1. Provision **disposable test chats**, with known actor identities, no private user history, and permission to spend against the selected providers. Keep conversational follow-up tests in the same chat, but do not reuse other scenario histories.
2. Install project dependencies and Chromium, and prepare a Playwright `storageState` JSON from an authorized browser session. **Do not commit** storage state, screenshots or response artifacts; they may contain sensitive content. Store them outside the repository or in ignored `artifacts/`.
3. Select the requested exact model in Katie's existing UI before running the corresponding case. This script **does not change the model selector**; it checks the outbound `overrideProvider` and `overrideModel` and fails when either differs from the declared expectation. Never silently accept a fallback as the requested model.
4. Fill a local config based on the example below, using the exact chat URLs for disposable actor/chat contexts.
5. Set `KATIE_ACCEPTANCE_CONFIG`, `KATIE_ACCEPTANCE_STORAGE_STATE`, and `KATIE_ACCEPTANCE_CHROMIUM` (absolute executable path). Optionally set `KATIE_ACCEPTANCE_OUTPUT`.
6. Execute `node scripts/adaptive-composition-live-acceptance.mjs`. Exit zero only means that delivery, routing and browser capture succeeded; **it is not a judgment that the writing is good**.

## Example private config

```json
{
  "origin": "https://katie-mu.vercel.app",
  "confirmLiveSpend": true,
  "cases": [
    {
      "name": "greeting-openai",
      "url": "https://katie-mu.vercel.app/<disposable-chat-route>",
      "message": "Hey Katie, how's your day?",
      "provider": "openai",
      "model": "<exact-model-id-selected-in-UI>"
    }
  ]
}
```

The placeholders above are configuration instructions, not runnable acceptance evidence. Use verified model IDs/URLs from your authorized test setup. Run the scenarios below across OpenAI, Gemini, Anthropic and Grok where the configured models are available. Record unavailable models as **not tested**, never passed.

## Minimum scenario matrix

| Scenario | Probe / context | Expected reviewer assessment |
| --- | --- | --- |
| Greeting | Hey Katie, how's your day? | Natural short reply; no compulsory heading |
| Humor | Respond to friendly teasing | Playful without forced emoji |
| Accounting | Explain earned revenue versus billings | Accurate and readable structure |
| Finance comparison | Compare two funding choices with supplied figures | Table only when helpful, quantities correct |
| Troubleshooting | Investigate a reported API regression with limited evidence | Symptoms, hypotheses and verified evidence separated |
| PR status | Ask about an explicitly provided PR and its stated CI state | No invented identifiers or deployment claims |
| Long technical | Explain a multi-step design with a small code example | Valid hierarchy and fenced code |
| Sensitive personal | Express uncertainty or frustration | Respectful prose, no template |
| Simple factual | What does EBITDA stand for? | Direct reply |
| Follow-up | In same chat, ask 'What about the second option?' | Carries context without restarting |

Use separate runs/cases for each provider. Review all cases, not just successes.

## Independent review contract

The reviewer must be **independent of the implementation decisions**. Give them the original objective and the captured JSON, `.stream.bin`, and screenshots, without telling them which outputs are expected to be winners.

They must check:

- Whether each response is natural, readable and task-appropriate, rather than maximizing Markdown.
- Whether factual distinctions, calculations, and operational status are accurate.
- Whether actor personality and conversation continuity survive, including follow-ups.
- Whether partial streamed output converges to the final rendered output without lost content, broken tables/code, or persistent malformed Markdown.
- Whether the request was actually routed to the declared provider/model (captured request override is evidence of **requested routing**, not proof of actual provider execution). Verify provider telemetry separately.
- Whether token and latency overhead are acceptable using authoritative provider usage/telemetry, not guessed from character counts.

Each scenario needs a verdict (pass/fail/inconclusive), evidence reference, and concrete explanation; record critical failures and regressions. The full gate passes only when all required scenarios have actual generated responses, valid browser evidence, verified provider identity, and an independent reviewer sign-off. The harness does **not** self-certify any of these.

## Interpretation and limits

The harness records only UI-observable streaming snapshots and the complete HTTP response body. A UI DOM snapshot is not a server-side stream timestamp; it is still useful evidence of progressively rendered Markdown. The raw stream must be checked against the final UI state. A 200 status proves delivery, not quality, provider identity or business accuracy. A blocked model, missing session, timed-out request or empty answer is a **failed or untested** case, not skipped success.

Do not merge additional changes or call #758 fully accepted based solely on this runner's exit code.
