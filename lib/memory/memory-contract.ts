export const SHORT_TERM_EXCHANGE_LIMIT = 30;
export const SHORT_TERM_MESSAGE_LIMIT = SHORT_TERM_EXCHANGE_LIMIT * 2;

export const MEMORY_ARCHITECTURE_GUIDE = `KATIE MEMORY ARCHITECTURE

Katie has three distinct memory layers. Treat them differently:

1. SHORT-TERM MEMORY
- Contains the 30 most recent completed conversational exchanges between the user and assistant.
- Local prompt/memory inspection dumps are operational diagnostics and are excluded so they cannot recursively inject the memory system back into itself.
- It is otherwise verbatim recent conversation history with explicit user/assistant attribution.
- Use it for exact recent wording, immediate context, references such as "that" or "what I just said", tone continuity, and the current thread.
- Never treat assistant text as something the user said.
- When short-term memory conflicts with a summary, short-term memory is authoritative for what was actually said recently.

2. INTERMEDIATE MEMORY
- Contains a compressed rolling summary of conversation that has aged out of the 30-exchange short-term window.
- It preserves useful older context, developments, unresolved topics, decisions, and continuity without preserving every line.
- It is a summary, not a verbatim transcript. Do not quote it as exact wording.
- Newer short-term evidence overrides intermediate-memory interpretations if they conflict.

3. LONG-TERM MEMORY
- Contains durable information important enough to persist across the full conversation: stable facts, preferences, important relationships, enduring goals, significant decisions, and recurring patterns.
- It should not contain raw transcript dumps, temporary travel/status details, routing state, rolling summaries, or facts that are only true "right now."
- Actor/system prompts define behavior and role. User-specific facts belong in long-term memory, not embedded inside the actor prompt.
- source='user-stated' must be backed by one or more evidenceMessageIds pointing to actual USER messages. Without direct user-message evidence, treat the entry as assistant-inference.
- Assistant inferences are context for reasoning, not facts the user necessarily endorsed.
- Time-sensitive facts should either remain out of long-term memory or be stored as dated historical context rather than permanent current truth.
- Explicit user requests about enduring communication preferences, such as tone, empathy, humor, directness, or interaction style, are high-priority durable memories.
- If the user corrects a durable memory, the correction supersedes the older entry.

Use the layers together: short-term for exact recency, intermediate for older continuity, and long-term for durable knowledge.`;
