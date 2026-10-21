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

## Verification limits

At this checkpoint, cross-chat resume after clarification and third-application routing have **failed live**. Full simultaneous-application continuity remains **unverified live**. Durable professional-memory learning is also unverified; same-conversation factual continuity does not establish it. The orchestrator reports a separate observed long-term-memory error under investigation. These successful answers and review handoffs do not establish overall mission completion.
