# Active-task isolation: independent live acceptance record

Date: 2026-10-21. Production revision reported by orchestrator: `7ed9465599ef18e9c4b8baed6398375caafba2ed` (PR 625), deployment `dpl_CmbWSLbpjRg3HeBio37f91YMUczT`.

Test actor: `bca79e2a-4e0b-4da0-94a5-146818fa75cc` (Context Acceptance625). The orchestrator reports the original specialist's prompt/routing were cloned and review set to always. Inputs explicitly identify a fictional candidate; none of these facts describe the user. This reviewer reads persisted messages and request review audits through read-only SQL. Database evidence establishes the saved result; it does not independently establish what the UI rendered.

## Rubric

Evaluate final answers against the actual supplied input, independently of the product review verdict:

1. Correct active application and client business problem.
2. Directly relevant verified evidence takes priority over recent prior-application evidence.
3. Newly confirmed facts are used without embellishment.
4. Relevant history is reusable without importing old requirements.
5. Resuming an application preserves its prior requirements, choices, and drafting context.
6. Genuinely unresolved identity triggers clarification.
7. Alignment survives reviewer/model handoff.

Latency is request `created_at` to `completed_at`, including review; it is not a provider-only timing.

## Observed results

### A1: Initial FP&A application

- Chat: `5ab03a26-66d3-434e-bf44-2765d164ba09`.
- Request: `8974952c-1767-4dfe-8596-f5749975fbfc`.
- User message: `9a8993cb-ad18-49e7-957b-53326e129577`; assistant message: `23af2ae7-d193-4d40-8835-5358f48ec570`.
- Started `18:16:12.010Z`; completed `18:17:30.544Z`; latency **78.534 seconds**.
- Lead: `claude-haiku-5-5`; reviewer: `gpt-5.6-luna`; audit status `revised`, final verdict `approve`.

Input requests a concise positioning paragraph for Northstar Distribution's Interim FP&A Director role: integrated forecasting, lender covenant reporting, and board scenario analysis. Confirmed fictional Cedar Distribution facts from 2024: integrated income statement, balance sheet, and cash-flow forecast; preparation reduced from ten days to four; monthly lender covenant reporting; downside scenarios.

Final saved output:

> At Cedar Distribution in 2024, I built an integrated income statement, balance sheet, and cash-flow forecast and reduced its preparation time from ten days to four. I also produced monthly lender covenant reporting and downside scenarios. That combination of integrated forecasting, covenant reporting, and scenario analysis maps directly to Northstar's mandate. I would bring the same approach to Northstar's forecasting, lender reporting, and board scenario work, building models that give leadership and lenders a consistent basis for decisions.

Independent assessment: **pass for initial task alignment and evidence fidelity**. All supplied facts are represented accurately. Board work is future positioning, not an invented historical responsibility. The reviewer identified unsupported claims in the first draft (for example, more reliable management views); the published revision removed them. Cross-provider review preserved the active application.

### B1/B2: Switch to Controller, then generic examples question

Application B's user message `5ea8d2c2-4f7c-4f31-b0ff-b04402ec2ad1` introduces Granite Infrastructure's Interim Controller mandate: hands-on controllership, percentage-of-completion revenue recognition, WIP, job costing, and reliable close. It explicitly keeps A unfinished. Newly confirmed fictional facts:

- Harbor Civil, 2025: owned monthly cost-to-cost percentage-of-completion calculations and WIP schedules for 35 projects; reconciled costs, billings, and estimated costs to complete with project managers; identified $420,000 understated estimated costs and corrected the margin forecast before close.
- Ridge Utilities, 2023: rebuilt labor/equipment/subcontractor job-cost coding and reconciled project subledger to GL, reducing close from twelve days to seven.
- Fieldworks Services, 2022: resolved aged unbilled contract balances and documented revenue-recognition controls.

Acknowledgment request `5c9c8954-1be8-4383-927d-1477dd1193ee`, assistant `3d2d2e43-1402-46f6-b33a-42f82b8bfad9`, completed in **13.210 seconds**. It accurately acknowledged B's priorities and retained A for later; no examples were prematurely drafted.

The next literal question was: “Please share 3 to 5 examples of your relevant experience.” Request `90ea9be0-bd62-4650-bb63-4de9f44e742c`, assistant `cee7c349-3c0e-4e3e-8c09-ae03d9ef70c5`, completed in **109.553 seconds**. Lead `claude-haiku-5-5`, reviewer `gpt-5.6-luna`, review status `revised`, final verdict `approve`.

Final saved output:

> **1. Percentage-of-completion accounting and WIP oversight (Harbor Civil, 2025)**
> I owned the monthly cost-to-cost percentage-of-completion calculations and WIP schedules for 35 projects. I reconciled costs, billings, and estimated costs to complete with project managers, which identified $420,000 of understated estimated costs. I corrected the margin forecast before close.
>
> **2. Job costing and close reliability (Ridge Utilities, 2023)**
> I rebuilt the labor, equipment, and subcontractor job-cost coding and reconciled the project subledger to the general ledger. These changes reduced the close from twelve days to seven.
>
> **3. Contract balance cleanup and revenue-recognition controls (Fieldworks Services, 2022)**
> I resolved aged unbilled contract balances and documented the revenue-recognition controls.

Independent assessment: **pass for switching, current-client evidence selection, and use of newly supplied facts on a subsequent generic question**. Harbor's direct construction-accounting evidence leads; Ridge and Fieldworks add distinct relevant dimensions. Scope, dates, amounts, and close-time improvement are faithful to input. No Cedar forecasting or Northstar lender requirements appear. The audit contains both A and B source turns, so the correct selection occurred with historical application information available, not by simply withholding all history. Reviewer revisions removed unsupported outcome language without displacing the active task.

### B3: Incorporate a newly confirmed control accomplishment

Request `b9a3baf9-c376-4551-9e8d-dca051e60a07`, assistant `081c2fe5-0cd0-4a9f-ac9f-ff5a51fa7b8c`, completed in **66.869 seconds**. Same lead and reviewer; final approved. New input confirms a signed monthly project-manager review of estimated costs to complete and change orders, catching $180,000 of unapproved change-order revenue before recognition.

Independent assessment: **pass**. The final adds this control to the Harbor Civil example, retains three examples, and keeps the $180,000 revenue-prevention outcome distinct from the $420,000 estimated-cost correction. No unrelated Northstar priorities intrude. This demonstrates immediate use of new facts; it does not establish durable-memory storage.

### C1/C2: New-chat ambiguity followed by explicit resume

New chat `0d66ae31-47e2-4b56-86e1-11e9bce4a029` first receives the generic examples question (user `81d54e74-77bf-467e-a61e-29a3687a1f44`). Request `2a83d172-993f-4e61-aa1d-300afa4f572e`, assistant `53e48bef-df09-44be-b038-df0b947e165b`, completed in **1.370 seconds**, locally:

> Should these examples be for application A, Interim FP&A Director at Northstar Distribution, or application B, Interim Controller at Granite Infrastructure?

Independent assessment: **pass for genuine ambiguity**. Both saved applications are recognized and neither is silently selected.

The user then explicitly responds (message `ab9ffecb-23a1-4a21-9b14-3718e9045fe7`):

> Resume application A, Interim FP&A Director at Northstar Distribution. Use the previously confirmed candidate experience and the positioning we drafted. Give three relevant examples for that application.

Request `59b74382-33e1-48fa-a767-65d197064e47`, assistant `8125ecf3-b49d-4ba2-8146-703052775bd4`, completed in **2.832 seconds**, locally:

> Which saved project should I continue?

Independent assessment: **FAIL for recovery and cross-chat resume**. The user has resolved the application identity unambiguously, yet the system repeats a clarification instead of resuming the named application. This is a live continuity defect, even though it avoids silently selecting the wrong application. Root cause is not established by this output alone; reported to the orchestrator for investigation.

### B4: Change lead model and condense the current answer

User asks to condense the current three application examples to 180 words, retaining the strongest client-relevant evidence and newly confirmed control result. Request `07c312e8-2b52-4f4f-9896-6eddb344679f`, assistant `07d3865c-81c2-4b9f-956d-06a9421ef4cb`, completed in **122.037 seconds**. Persisted lead model is now `claude-sonnet-4-6`, reviewer `gpt-5.5-2026-04-23`; final approved.

Independent assessment: **pass for lead-model change and review handoff continuity**. The final retains the Harbor/Ridge/Fieldworks order, 35 projects, distinct $420,000 and $180,000 outcomes, and twelve-to-seven-day close improvement. It stays below 180 words and does not import Northstar requirements. Both lead and reviewer differ from earlier turns, while the active application remains Granite.

### D1: Reuse accomplishments for a third business mandate

User `b43bce3c-8640-4049-811f-086bd175abd7` requests application C, Finance Transformation Lead at Juniper Manufacturing: faster finance processes, reliable data reconciliation, and repeatable management reporting. It explicitly excludes a construction-accounting or lender-reporting mandate, requests two strongest previously confirmed examples, and keeps A/B available.

Request `a0e619dd-46a1-4beb-9157-7861a88faa39`, assistant `5b82c86a-4187-4115-b2a6-16bdb37cc010`, completed in **1.851 seconds** locally. Instead of an application answer it launched persistent project `4dfaa774-12dd-40f4-ab26-3dc80ec2e5f1` and promised research, architecture, coding approval, implementation, and preview delivery. A subsequent saved status message reports a research milestone.

Independent assessment: **FAIL for task routing/scope**. A career application request was routed into a software-project workflow. No generated relevance answer exists to assess. The output establishes the routing failure, but not its underlying mechanism; reported immediately to the orchestrator. This reviewer made no project or database mutation.

### D2: Stop the accidentally launched coding project

The orchestrator reports submitting “Stop the coding project.” Request `802974d1-1fd2-469b-8a7f-bb98fa593884`, assistant `116c89b2-fd1a-458c-ae6b-813e90edc565`, completed in **1.307 seconds**. Independently retrieved saved answer:

> Which project do you mean? The available projects are applications A, B, and C; no coding project is currently identified.

Independent assessment: **FAIL for control continuity**. The preceding local response and saved status messages identify an actual launched coding project, but the stop request is redirected to career-application ambiguity. The orchestrator reports subsequently stopping project `4dfaa774-12dd-40f4-ab26-3dc80ec2e5f1` with the existing actor/chat-scoped control RPC and confirming `stopped`. That manual cleanup is not evidence that conversational stop handling passed. No original actor memory was changed, according to the orchestrator.

Cleanup followup reported by the orchestrator: the already admitted research mission (ID prefix `5f31bfbd`) remained running under existing project-stop behavior. The orchestrator used the existing mission stop RPC and confirmed that mission stopped as well. Already in-flight provider execution may finish under existing cancellation semantics; no new launch was authorized. This record does not claim a cancellation-architecture change.

### M1: Durable-memory provenance inspection

Read-only inspection of `actor_long_term_memory` for the isolated test actor, row updated `2026-10-21T18:25:43.233071Z`, independently confirms entry `candidate.application.examples.condensed` contains the full three-example assistant draft, labeled `source=user-stated`, `confidence=high`. Its sole cited evidence message is `7a0f0625-60a9-41a3-986c-6f8e987819d3`, quoting only the instruction to condense to 180 words and retain the strongest/new control evidence.

Independent assessment: **FAIL for durable-memory source attribution**. That user instruction does not entail the stored factual claims. Some underlying facts are supported elsewhere in the conversation, but the entry does not cite those sources; the literal quote validation accepted an unrelated instruction as evidence. The row separately preserves a fictional-fixture disclaimer and the directly sourced $180,000 control fact. Those valid entries do not cure the draft's false attribution. The orchestrator is investigating a semantic evidence-validation correction; no repair is claimed here.

## Followup release and original-memory correction checkpoint

The orchestrator reports PR #627's JSON repair admission fix is deployed READY. Integrated PR #629 (required task resolution, software-build admission, stop continuity, and semantic memory support) passed CI and website review at head `24920a69` and merged as `6b0729c1fc46e8db07d6cc37ef5341adbc88efe4`. Deployment `dpl_4aemEAtLqELxFiANXpeP7Bxv5WoF` was verified READY on the canonical alias around 18:46 UTC. Live retests began afterward; the observations above remain pre-fix results and are not erased by the new deployment.

Chronological correction to the earlier “original actor memory unchanged” checkpoint: after those tests, one original-actor attribution entry was independently reviewed against its exact USER source and corrected with approval. Entry `katie.sponsor.reporting.experience` on actor `d36824aa-7fcd-4a7a-978a-73f073ccc789` incorrectly attributed the user's sponsor-reporting experience to Katie/she. The context investigator reports a guarded value-only correction to Mark/he at `2026-10-21T18:45:28.748582Z`, revision 9 to 10, preserving all metadata and verifying the other 152 entries unchanged (153 total). The reviewer independently verified the source and original error before execution but did not execute the mutation. The ambiguous interim-preference entry remains untouched.

## Post-PR #629 live retests

### R1: Exact named cross-chat resume

The original explicit A resume request was resubmitted in chat `0d66ae31-47e2-4b56-86e1-11e9bce4a029` after the canonical deployment was READY. Request `bc319352-f087-4b45-9ebd-57fbb81c9df1`, assistant `c0cb1c3c-7055-4946-8515-836b980e2a4a`, completed in **139.915 seconds**, lead `claude-haiku-5-5`, reviewer `gpt-5.6-luna`, revised and approved.

Independent assessment: **PASS on retest**. The final produces three Cedar Distribution examples aligned to Northstar: integrated income statement/balance-sheet/cash-flow forecasting with the ten-to-four-day improvement, monthly covenant reporting, and downside scenarios. It does not repeat the failed clarification, ask for previously supplied facts, or import Controller priorities. Board scenario analysis is described as relevance to the target role, not invented past board responsibility. This resolves the observed C2 resume failure for this tested input; the earlier failure remains in the record.

### R2: Generic followup after resume while another application runs

In A's resumed chat, the user asks only to condense those examples into one paragraph of at most 100 words, preserving the strongest quantified outcome. Request `26f653fe-fe99-4993-9e67-80014c68b360`, assistant `b494abf9-edf8-4613-8c80-1708114a8dd7`, completed in **89.772 seconds**, Haiku/Luna, approved.

Independent assessment: **PASS**. The 69-word paragraph remains Northstar/Cedar, includes the integrated forecast, ten-to-four-day improvement, covenant reporting and downside scenarios, with no repeated brief or facts needed. The review source set includes the original A user brief and resumed objective. Application D was being processed separately at the same time; its requirements did not displace A's.

### R3: New application and relevant historical evidence reuse

Application D repeats the Juniper Finance Transformation Lead business problem from the earlier failed C attempt, explicitly as a distinct application, retaining A/B. Request `a5689c69-09bc-4a3f-9078-d3b739a04169`, assistant `bc471b37-b1f1-4226-ad41-d61f0d33f621`, completed in **217.662 seconds**, lead `gpt-5.4-mini-2026-03-17`, reviewer `claude-opus-5-5`, revised and approved.

The final selects Ridge's close reduction from twelve days to seven through cost coding and subledger/GL reconciliation, followed by Cedar's integrated forecast and preparation reduction from ten days to four. It explicitly links these to faster processes, reliable reconciliation, and repeatable reporting, followed by a separate note that D is distinct from C and A/B remain open.

Independent assessment: **PASS for the previously failed new-application route and for relevant history reuse**. It generates a career application answer, rather than a coding-project launch. It draws appropriate facts from both earlier applications while excluding obsolete construction-accounting/lender mandates. It does not invent manufacturing experience or systems. Parallel A and D outputs demonstrate distinct active objectives in separate chats, beyond merely preserving registry state.

### R4: Post-fix durable-memory source inspection

Read-only inspection of the test actor's durable memory updated `2026-10-21T18:53:24.992873Z` reveals a new entry `application.D.Juniper.Manufacturing`. It contains first-person Ridge/Cedar accomplishments from the generated D answer, marked high-confidence `user-stated`, but its sole citation is user message `94cd791d-6ba2-4a24-a376-0ea968ceb3d8`, whose quote establishes the Juniper role and requirements, not those accomplishments. Entry `candidate.application.examples.relevant` also stores the A resume instruction itself as a durable fact.

Independent assessment: **FAIL persists after #629 for durable source attribution and memory scope**. The user-facing D answer is well supported by earlier source turns, but the stored entry does not cite them, and its task-local draft is not persistent professional knowledge. The independent semantic review had access to other user messages; the result shows that the instruction not to substitute those messages was insufficient. It does not reveal the exact internal reasoning. A followup is being designed to structurally isolate each candidate's cited USER sources for factual entailment before a separate contextual qualification check. No success is claimed for that untested correction.

### R5: Stop request after manual cleanup

After the accidentally launched work had already been stopped, the user submitted “Stop the coding project.” Request `a8572c40-9181-402d-b8ac-7e117c184718`, assistant `db8d616a-e1a0-462d-b084-b4ae118cca03`, completed in **30.658 seconds**. It says no coding project is running, but then claims B has no examples drafted and A is paused “as you asked.” B has several saved example drafts; A was retained open and resumed.

Independent assessment: **limited result, not a full stop-control pass**. No new work was launched and the previous A/B/C clarification dead-end did not recur. However, this was not a stop of running work, and the generated application-status recap is inaccurate. Actual bound stop execution remains deterministically tested rather than established by this already-stopped live case. The misleading progress recap was reported to the orchestrator.

### R6: Resume B's latest prepared draft

The user requests: “Resume application B at Granite Infrastructure and show the latest three-example draft we already prepared, including the subsequently confirmed control result.” Request `2d5ad2bb-73c8-470e-8069-0fbced60467e`, assistant `3c633f7e-d23f-4135-96b3-c35fe6c03f0a`, completed in **63.694 seconds** with:

> I couldn’t verify that this draft answers the current task. I need to resolve the conflicting requirements before providing a finished answer.

Independent assessment: **FAIL for successful latest-draft resume**. The audit's user-source set contains the correct B brief, all three examples, and the $180,000 addition. The contract validator twice required retaining the prior 180-word limit; bounded repair still failed to incorporate it. A secondary finding concerns an unsupported exclusion attributed to a user turn. The validator also notes prior draft text was not supplied in its input. This is evidence of unsuccessful contract repair/continuity, not evidence that all relevant facts were lost. The system withheld an unverified result instead of presenting a misleading approved draft, but the user's requested outcome was not delivered.

### R7: Reuse newly learned professional evidence in a fresh application chat

Application E supplies a new explicitly fictional Atlas Manufacturing accomplishment in user message `d0d6d588-1dfe-4403-9c85-a00708273307`: in 2021, consolidated six subsidiaries, reconciled intercompany balances, and reduced group reporting preparation from eight days to three. Durable entry `application.E.Maple.Health` preserves these facts, fictional attribution, and the exact original user source.

In fresh chat `12b602be-b246-405e-a0a9-d0920d91e347`, application F requests the strongest prior example for Elm Retail's Group Reporting Lead mandate without resupplying facts. Request `d7ad729c-079a-4cf6-bc01-34c1c6290006`, assistant `0bbef90c-8e75-4906-9deb-a952a753f0d6`, completed in **123.602 seconds**, lead `claude-fable-5-1`, reviewer `gpt-5.6-luna`.

Independent assessment: **PASS for relevant durable-memory reuse, with a review qualification**. The final selects Atlas's six subsidiaries/intercompany work/eight-to-three-day result and connects it to Elm's needs. The audit's user-source list contains only the F request; the provider system contains the persisted E memory entry with original factual provenance, while rendered historical task context lists only IDs. This supports actual actor-wide durable-memory use, not merely same-chat recall. The system completed with review notes (`verdict=revise`): the reviewer asked to remove “achieved in a single engagement,” but that minor phrase remains. It is not a fully reviewer-approved answer. One correctly stored/reused entry does not negate the independently observed wrong-source entries.

### H1: Explicit managed handoff UI after #631

The orchestrator reports #631 deployed READY, but the first handoff attempt after opening E in the modern workspace failed its source preview with “Open the source conversation first.” Source inspection shows only the legacy workspace wrote the active-chat localStorage key used by the new preview. No managed handoff answer was produced.

Independent review approved a narrow modern-workspace fix: synchronize chat/actor IDs only once the actual existing pair is loaded; browser acceptance now asserts both IDs after real conversation navigation. The fix still requires deployment and a live retry. This UI failure is distinct from the successful receipt migration and PostgreSQL tests.

## Verification limits

Current release checkpoint: PR #632 isolated-citation/durability gate is deployed READY (`dpl_A2nrz5WM…`, merge prefix `e6aedd`), with a fresh Atlas control-fact request submitted for actual provider/memory verification. PR #634 modern-workspace handoff source fix is pending. Additional latest-draft/contract-repair and selected professional-knowledge capsule changes have passed scoped independent code review and deterministic tests, but are not yet live-verified. Knowledge transfer includes original owned USER evidence and keeps it separate from active task requirements; it does not clone all professional memory.

Handoff checkpoint: the orchestrator reports PR #631 CI/website review passed, its reviewed receipt migration applied, and merge `30b809e83d65369555034c6ef037549c852a36a3`. The isolated managed specialist ContextHandoffAcceptance631 was created through the UI (review always, research/development disabled). Deployment and actual handoff output remain pending; no live pass is implied by migration or task creation.

A's cross-chat resume, subsequent generic followup, distinct concurrent applications, new-application routing, and relevant historical reuse have **passed post-fix live retests**. B's latest-draft resume and durable-memory source attribution **failed after #629**. Conversational stop recovery awaits a successful live retest. Explicit managed-specialist handoff remains **unverified live**. These successful answers and review handoffs do not establish overall mission completion.
