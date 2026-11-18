# Actor-specific operating instruction ownership — Phase 1 map

This map is based on the live `actors` records, the existing prompt assembly code,
and the exact current text in `lib/chat/deliverable-standard.ts`,
`lib/chat/adaptive-response-composition.ts`, and `lib/memory/memory-contract.ts`.
It is a classification **before any production behavior change**.

## Instruction sources and ownership

| Source | Ownership | Treatment |
|---|---|---|
| `actors.system_prompt` | Individual actor | Preserve verbatim, including BTG and Katie's established personality |
| Deliverable standard: objective, comparative alternatives/consequences/decision, whole-result challenge, conversation progression, source truth, correction handling, task completion | Universal | Reuse exact existing sentences; no new instructions |
| Deliverable standard: full FIT/APPLICATION/FINANCIAL/TECHNICAL stance paragraph | Reusable task-stance module | Keep exact original paragraph; initially BTG only |
| `APPLICATION COMPLETION:` paragraph | Reusable application-completion module | Preserve exact text; initially BTG only |
| `EVIDENCE-BASED CAPABILITY REASONING:` paragraph | Reusable professional-evidence module | Preserve exact text; initially BTG only |
| `Communicate the selected evidence...` paragraph | Reusable professional-communication module | Preserve exact text; initially BTG only |
| `TECHNICAL WORK prioritizes diagnosis...` clause | Reusable technical-stance module | Exact existing clause; initially Builder only |
| `FINANCIAL REPORT presents neutral analysis...` clause | Reusable financial-stance module | Retain as a module; no inferred owner assignment |
| Adaptive response-composition instructions | Universal | Remain **verbatim**; shape expression, not actor role or domain workflow |
| Memory architecture guide | Universal | Remain **verbatim**, including source hierarchy and correction controls |
| `currentAgentTask()?.snapshot.instructions` | Authorized active task | Preserve existing snapshot precedence and policy |
| Corrections / STM / ITM / LTM / reference documents / reactions / visual context | Existing memory system | No change |

## Initial actor assignments (exact IDs, never name matching)

| Actor ID | Actor | Mode | Modules | Justification |
|---|---|---|---|---|
| `f94eeb41-9bcd-4eb8-9896-bb92e5e3b5c0` | Regular owner Katie | Modular | None | General conversational actor; personality remains stored verbatim |
| `d36824aa-7fcd-4a7a-978a-73f073ccc789` | BTG Application Specialits (database spelling) | Modular | task-stance, application-completion, professional-evidence, professional-communication | Explicit existing executive application adviser purpose |
| `6c178d99-6d19-49e6-83ac-a2d7eff3d458` | Builder | Modular | technical-stance | Explicit existing backend architecture/implementation purpose |
| All other actor IDs (including guest Katie identities and managed workers) | Existing | Legacy | None | Preserve existing instructions; no assignment inferred |

**Legacy** means retaining the exact previous global deliverable + adaptive + memory
assembly. A missing, unknown or incomplete module configuration must fall back
safely to the legacy path. New actors start in legacy mode and can be configured
explicitly without a code deployment.

## Boundaries

- No changes to actor prompts, capabilities, permissions, stored memories,
  routing, fallback, provider calls or ordinary chat database round-trip count.
- A single existing actor read will embed module assignments and definitions
  through PostgREST's existing `actors` query; no second read during chat.
- The optional configuration editor is placed inside the existing actor settings.
- Reusable module bodies are stored once in the database and can be edited there.
- Any remaining ambiguous actor is listed above as legacy instead of silently
  assigning a specialization.
- No global text simplification, rewriting, or additional context pruning.
