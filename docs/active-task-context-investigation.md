# Active-task context isolation investigation

Status: implementation and deterministic regression review completed; live acceptance remains open. Do not interpret this report or a passing focused suite as proof that Katie now chooses the strongest evidence in production.

## Evidence and causal findings

Investigation used repository source at base `5a77c25`, actor instructions and memory records in Supabase, saved provider/review audits, and Vercel request logs. Incident: actor `d36824aa-7fcd-4a7a-978a-73f073ccc789`, chat `8b2171ea-2dfa-4c28-86fd-d8fee1bd0836`, request `d4937a01-3a97-44e2-adf7-e24d05a638b4`, 2026-10-21 16:27:48 UTC. The current user message was “Please share 3 to 5 examples of your relevant experience.”

| Finding | Supporting evidence | Interpretation |
| --- | --- | --- |
| An obsolete opportunity was reintroduced as source material | Background-selection log: zero new files, catalog size one, summary-selector selected source `84c1afd2-0ddf-4460-92a1-1a617df6cba9`, an earlier Interim FP&A Director screenshot | Confirmed contamination path, not simply an absent career fact |
| Active parent identity was lost | ResponsePolicy recorded both parent project and current task as the generic examples-request message | Shared state allowed a subquestion to displace its application |
| Relevant construction experience was available | Provider-system audit includes WIP/percentage-of-completion; reviewer audit includes construction | No evidence of wholesale retrieval loss; availability alone did not ensure selection |
| Review noticed and subsequently lost the conflict | First contract finding rejected the FP&A target and identified the newer Controller engagement; later approval treated only the latest generic question as authoritative | Reviewer repair could erase the very objection it needed to resolve |
| Existing actor instructions were already substantive | Application actor instructions already require client-specific evidence and appropriate examples | Adding another actor prompt would not address the demonstrated shared defects |

Source inspection independently confirmed: historical media selection occurred before task identification; provenance protection covered video but not all source kinds; reused images could become new-looking conversational evidence; parent state was a single overwriteable field; changing questions cleared prior answers; parent briefs were truncated; a compacted-away parent was not reliably citeable by review; incomplete summarization could advance the memory cursor.

The incident establishes the retrieval/state/review chain above. It does **not** establish that compaction or a model switch caused this particular failure. Those are separate verified vulnerabilities addressed or tested here. No evidence establishes a defect in one particular generation model. These mechanisms are shared by specialists; the observed behavioral incident is in the application actor. Other actors have not undergone live acceptance testing.

## Implemented architecture

1. Resolve task identity from the current user input, permitted fresh source evidence, and the saved task registry before retrieving historical attachments. The later capability router cannot replace that identity. Explicit new/resume transitions require a source quote; resume requires a known project ID. Ambiguity stops generation and project side effects with a clarification.
2. Keep complete application snapshots separate from the current question: parent requirements, pending/answered clarifications, original chat/message provenance, and version timestamps. New questions retain confirmed answers. Cross-chat catalogs are references until a validated resume. Reload original application conversation/drafts on resume and subsequent turns, respecting actor ownership and the next application boundary.
3. Pass active project context separately from the generic router history window. Historical attachment ranking receives the active requirements. All source types distinguish uploaded, explicit-reference and contextual use; contextual retrieval cannot renew upload recency.
4. Give review a citeable parent brief even when absent from recent transcript. Require active-task identity in the final response contract. Carry material objections across repair attempts and require source-supported resolutions; withhold a candidate if a material identity objection remains unresolved.
5. Reject empty/incomplete summary output before advancing the compaction cursor.

No domain-specific ranking rule, actor rewrite, model pin, database migration, career-memory deletion, or previous-application deletion was introduced. Persistent professional knowledge remains in the existing memory system; application requirements/decisions live in explicit task snapshots. Historical accomplishments remain available as reference evidence. Current requirements govern generation and independent review. This preserves the opportunity to learn; it is not yet live proof of durable extraction and reuse of every newly confirmed fact.

## Reproducible verification

Run `npm run typecheck`, `npm run test:review`, and `npm test`. The normal full runner discovers the new registry and summarizer tests. Route harnesses transpile production route blocks, rather than substitute a separate implementation.

Focused validation before broad-suite compatibility corrections: typecheck passed; required-review suite 149 tests passed; Google routing 108 passed; task continuity/registry 31 passed; attachment focus 33 passed; actual-route clarification/resume harness 10 passed; summarizer cursor 3 passed. Independent reviewer separately ran the route harness (10) and registry (9), then the Executive boundary test (3). Review tests inspect final returned responses and ensure a wrong-target candidate is withheld; their providers are fixtures, not live model judgments.

The broader run exposed PDF/media harness assumptions after moving task resolution earlier, and a real source-scope issue: excluded fresh PDF text could enter early identity classification. The source-scope correction and updated harness results are recorded in the final validation update below. Database/browser integration failures must not be counted as passes.

## Live acceptance protocol — not yet executed

Use isolated test chats and synthetic facts, never write fixture claims into the user's professional memory. Keep production career data intact. Capture each request ID, deployment SHA, model, active project ID, selected source IDs, final answer, and independent review audit. Have a separate reviewer judge the actual final answer against the active brief and the supplied facts.

| Required scenario | Deterministic coverage | Live pass condition |
| --- | --- | --- |
| Switch between substantially different applications | Old FP&A screenshot/current Controller fixture; frozen parent identity; persistent review objection | Controller answer leads with supported project accounting/WIP/job-costing evidence rather than defaulting to the old forecasting story |
| Return to unfinished application | Snapshot restore, source-chat history and subsequent-turn route tests | Resume original requirements, draft and unresolved decisions without asking for facts already supplied |
| Add experience, then ask for examples | Answer preservation on new question; full source context tests | Newly supplied relevant accomplishment appears accurately in the next answer and remains available later |
| Reuse historical accomplishment | Contextual source provenance and review contract tests | Reuse facts that fit current needs without importing the historical client's priorities |
| Model change or specialist handoff | Provider-independent serialized state and dedicated router context tests | Actual new model/specialist receives the same active application and produces relevant examples; cross-actor transfer is not yet proven |
| Simultaneous applications | Separate snapshots, cross-chat catalog, timestamp refresh tests | Working on B does not alter A's requirements; returning to A restores A |
| Ambiguous active task | Generic examples/continue with multiple saved projects; clarification route tests | Ask which application before choosing evidence; clarify and resume the selected one |

Use both the incident domain and a different pair of synthetic engagements to test generality. A reviewer must assess relevance, support, outcome specificity, recency where known, and unsupported claims. State persistence alone is insufficient. Exact wording or mandatory keyword counts are not acceptance criteria.

## Orchestration and outstanding limits

A native Katie mission was created through the existing mission RPC using its saved Mission Lead, Analysis and Development team, scoped to independent read-only investigation: `7047194c-8da7-4a3b-9a9e-a95391691aa2`. It blocked during planning with `Model output incomplete: incomplete` after one recorded call / 10,047 actual tokens. No native specialist output was produced. Its budget was not reset or increased. The external implementation/review specialists did complete their separate code review work; that is not a substitute for a successful native mission.

The deployed application requires Vercel authentication in the available browser. The connector can read protected deployment URLs but does not provide the interactive POST workflow needed for these conversations. No production merge/deployment or live acceptance is claimed.

Remaining risks: actor-wide memory remains broad rather than relevance-ranked; model judgment can still choose weak evidence despite correct context; multi-writer updates of the same application need concurrency testing; very long restored histories need context-budget evaluation; actual cross-specialist transfer and durable professional-memory extraction require live verification. Fresh images do not have the PDF-equivalent exclusion/save-only source gate; image observation was already broad and remains so. Full untruncated task history favors fidelity but can increase prompt cost. Native planner incomplete-output recovery is unresolved and separate from this patch.

## Final validation update

`npm run build` passed compilation, lint, type validation, and static-page generation. Its existing postbuild storage smoke explicitly skipped real storage verification outside production; that is not a live storage pass. Existing `module.createRequire` warnings in video recovery remain.

The full run completed: 1,153 tests passed in successful Node test files, and all 7 Vitest tests passed; 17 Node files failed. Six failures were route-harness assumptions exposed by moving resolution earlier (Executive, media-memory, three PDF, video-timeline). Targeted reruns corrected those fixtures while retaining their source-isolation assertions. The new PDF source-scope production correction plus its surrounding focused suites passed 153/153; Executive passed 3/3. Video timeline passed 6/6. Independent review separately reran the three PDF suites: 132/132 passed, with no remaining blocker in the scoped correction.

The other eleven failures remain open: eight SQL files cannot initialize the required local PostgreSQL binaries; API startup fails on network-interface permission; browser isolation checks fail on unavailable user namespaces/expected executable location; the unchanged test-runner self-test timed out. Classification is based on failure locations and unchanged code, not a clean baseline replay. No security sandbox or test gate was disabled, and these are not reported as passes. The full suite has **not** passed.
