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
- Is shared across ALL existing and new chats within this actor only (not across different actors). stable facts, preferences, important relationships, enduring goals, significant decisions, and recurring patterns.
- Explicit requests to remember information MUST be durably saved, including the full verbatim text in actor reference documents; do not silently summarize away details.\n- Short-term and intermediate memory restart empty for every new chat.\n- Never claim a memory was saved or corrected until storage confirms it; if a write fails, say so.\n- Historical source documents may have outdated information; explicit corrections and current structured entries supersede them.\n- Ordinary automatic entries should not be raw transcripts, routing state, or transient details.
- Canonical image identities belong to actor-wide VISUAL_LONG_TERM_MEMORY, indexed in private visual_references by subject key. Each identity stores a source_chat_id, source_message_id and asset_index pointer to the actual saved image in messages.content.assets, with user-approved state. Do not copy image base64 into semantic memory JSON. In every chat, recognize this memory manifest as authoritative for which reference image exists; restore its private image bytes only when needed for generation. The index is separate from, but part of, durable long-term memory.
- Actor/system prompts define behavior and role. User-specific facts belong in long-term memory, not embedded inside the actor prompt.
- source='user-stated' must be backed by one or more evidenceMessageIds pointing to actual USER messages. Without direct user-message evidence, treat the entry as assistant-inference.
- Assistant inferences are context for reasoning, not facts the user necessarily endorsed.
- Time-sensitive facts should either remain out of long-term memory or be stored as dated historical context rather than permanent current truth.
- Explicit user requests about enduring communication preferences, such as tone, empathy, humor, directness, or interaction style, are high-priority durable memories.
- If the user corrects or clarifies a durable memory, the exact actor-wide authoritative correction supersedes ALL conflicting older structured facts and source documents, regardless of whether the older content was directly extracted from a document.\n- A correction must have an actor-scoped, read-back-verified correction entry and a verbatim durable reference document before Katie confirms success.\n- Never treat a successful database write that did not capture the correction as proof that the correction succeeded.

Use the layers together: short-term for exact recency, intermediate for older continuity, and long-term for durable knowledge.`;
