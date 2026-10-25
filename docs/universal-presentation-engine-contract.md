# Katie universal presentation engine — integration contract (draft)

## Verified repository boundaries (2026-10-25)

- The deployed-compatible Next.js chat path is anchored in `app/api/chat/route.ts` and `components/chat-panel.tsx`. The latter currently displays assistant text through ReactMarkdown/remark-gfm.
- `lib/types/chat.ts::Message` currently carries text, model, assets and attachments, not a structured response envelope.
- `lib/data/persistence-store.ts` persists existing message content through `encodeMessageContent` / `parseMessageContent`; historical non-JSON content must remain valid.
- The compositional formatting work was tracked under PR #758 (closed). Structured visual component work is active as PR #761 (draft), with its own `lib/chat/structured-response.ts` and `components/structured-response-view.tsx`. PR #762 also touches Markdown rendering.
- This branch deliberately does not edit chat routing, renderer, persistence or component implementations to avoid conflicting with either workstream.

## Ownership / dependency contract

1. **Composition** owns model instructions for prose, headings, tables and emoji. No new actor, router, or model call.
2. **Visual components** owns each approved component schema, rendering implementation, accessibility and its Markdown fallback. It must expose explicit version and resource bounds.
3. **Universal engine** owns the registry, capability negotiation, ordered response envelope, validation at trust boundaries, streaming/persistence integration, and system-wide acceptance. No duplicate component implementations.

## Proposed canonical envelope (integration target, not yet wired)

```ts
type PresentationMessageV1 = {
  version: 1;
  messageId: string;
  revision: number;
  blocks: Array<{
    id: string;          // stable within message, unique
    component: string;   // allowlisted registry ID
    componentVersion: number;
    payload: unknown;    // validated through registered component
    fallback: string;    // validated text or canonical fallback
  }>;
  fallbackMarkdown: string;
};
```

The registry implemented on this branch is a separate primitive, **not** a second incompatible response envelope. The envelope must be reconciled with PR #761 before any production integration. The `fallbackMarkdown` text remains the canonical readable answer for a client with no structured capabilities. Rich blocks must never be used as instructions to tools or memory systems.

## Integration and trust boundary

1. Existing selected model and tool context produce response content. Provider-specific structured output may be adapted, but all providers enter **one** validation pipeline. Unsupported models keep normal Markdown.
2. Stream ordinary Markdown as today. Rich specs must be buffered to a bounded size, validated on the server **before** display, then assigned stable block IDs and emitted once with a monotonically increasing revision. Never render incomplete component JSON.
3. Persist the validated envelope atomically with the assistant message in its existing authenticated conversation scope. Do not rely on browser-only state. Only after persistence acknowledgement may a final rich event be treated as committed.
4. Fetch the same representation via the existing message retrieval endpoint on refresh and reopen. Old content stays unchanged; unsupported/invalid versions display their stored Markdown fallback.
5. Browser receives only approved component identifiers and parsed payloads. Interactions in this registry are **local presentation actions only**. Open URL, write, deletion, spending, deployment, agent launch and other privileged operations must travel through existing authenticated, audited commands; a generated block is never authorization.
6. Client capabilities are advisory and cannot elevate authorization. Negotiation intersects claimed support with the compiled registry; unknown versions default to Markdown.

## Migration and rollback

- Do not overwrite or reinterpret legacy saved content. A versioned optional presentation field in the existing message JSON envelope is preferable to a separate source of truth, subject to the existing API's size and performance constraints. Migration must be backward-compatible with old readers.
- Stage behind a default-off server feature gate until integration, security, and browser acceptance pass.
- Rollback disables rich selection and rendering; existing conversations continue through Markdown fallbacks without data loss.
- Define atomicity and idempotency for retry/reconnect before enabling streaming structured events.

## Unverified work — strict NO-GO

- Reconcile shared types with PR #761; implement ordered envelope with stable IDs and validated references.
- Wire provider guidance/adapters, chat lifecycle, request cancellation and stream recovery, persistence, and rehydration without parallel pipelines.
- Require direct server-side validation and defensive client-side validation, including media/url provenance and actions.
- Test screen readers and mobile, interactions, interrupted stream, retry deduplication, legacy conversations, expensive payloads, and malicious content.
- Run real, budget-authorized responses across current provider models. Record identity, raw streamed output, persisted output, replay fidelity, tokens, overhead and latency.
- Independent security/architecture review followed by a single integrated acceptance report.

**This branch is registry infrastructure only. It is not a claim of a working presentation engine or production readiness.**
