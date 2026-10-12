# Objective-first prompt refinement

## Diagnosis and changes

The existing prompts already requested contextual judgment, but repeated overlapping drafting and editorial rules. Some instructions still encouraged comprehensive checklist completion, task validation used "persuasive" as a general standard, and revision/final review treated prior edit requests too mechanically.

Changed:
- `lib/chat/deliverable-standard.ts`: one shared objective-first standard; shorter drafting instructions; task-specific stance; source-grounded claims; output type and factual boundaries preserved across actors.
- `lib/collaboration/review-contract.ts`: reused the shared standard and removed duplicate editorial rules. Existing source attribution, chronology, metrics, requirements, progression and acceptance checks remain.
- `lib/collaboration/required-review.ts`: draft-blind assessment defines an independent approach; contract validation evaluates effectiveness rather than universal persuasion; revision can rebuild the answer; final verification judges objective and material harm rather than literal obedience to previous edit suggestions.

No agents, review stages, tables, routing changes or production model calls were added. The separate review-orchestration branch is excluded. Actor personalities and user constraints remain intact.

## Actual model tests

Baseline: production-source commit `84baaab`. Primary model: API-discovered `claude-sonnet-5-5`. Review used a distinct API-discovered Opus model, recorded in the result artifacts. All live inputs were wholly fictional. These are single-sample qualitative comparisons, not statistical proof or a production-chat end-to-end test.

Five primary cases covered a CFO application, qualification assessment, cash analysis, checkout diagnosis and vendor communication. Both baseline and candidate correctly distinguished revenue from valuation, kept separate engagements distinct, did not invent direct transfer-pricing experience, calculated the $25,000 cash shortfall and checkout total of 99, and preserved an update promise without inventing a payment commitment.

Early candidate answers still invented employment status and responsibilities and used conventional letter scaffolding. Those results are retained. Further prompt simplification and source-grounding reduced some overstatement, but first-draft improvement remains modest and variable; these tests do not establish substantially better first drafts across all tasks.

An actual independent-review test supplied a deliberately weak but accurate application leading with gaps and including irrelevant hospitality experience. Baseline rejected its strategy and approved after two revisions. The first candidate also rejected the strategy but exhausted all three repairs over residual stylistic edits, returning `completed_with_review_notes`. The materiality/alternate-solution clarification corrected that regression: the final reviewer retest returned `revised` with an approved final answer after two revisions. Both selected stronger relevant evidence and removed the irrelevant example. The final retest did not prove fewer model calls than baseline.

Exact outputs, findings and failed iterations are in `docs/evals/`. The prepared evaluation scripts are development-only and do not write Katie chat data.

## Automated validation

- `npm test`: passed (all test groups).
- `npm run test:review`: 73 passed, including BTG regression, actor isolation, source preservation, prompt delivery and unchanged review-stage coverage.
- Production build: passed.
- URL/deprecation check and patch whitespace check: passed.
- Local startup works when bound explicitly to localhost. The default smoke script encounters this environment's network-interface limitation; use deployment HTTP checks for release verification.

## Limitations

Automatic approval review blocked disclosing the real BTG career facts and prompts to Anthropic. The real BTG case has local regression coverage, but its live A/B comparison remains unrun pending explicit disclosure approval. No claim of consistent first-attempt excellence is supported by this limited benchmark. Residual conventional formatting and broad capability phrasing still require monitoring.
