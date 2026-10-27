# Developer specification lifecycle correction (#696)

## Observed failure

Read-only inspection of project `401fddcb-8c3f-470f-be54-0612e36f647d` found 14 missions, 940,907 charged tokens (sum of each mission's `max(actual_tokens,reserved_tokens)`), 9,093 remaining of the unchanged 950,000 authorization, all 14 mission slots used, and an expired deadline. Its status remained blocked at specification. No inspection or test resumed that project.

The saved recovery event points to compose job `31853738-0216-499c-b708-196b84781e30` (29,015 characters). A later completed revision, `f35c1e6d-adc2-4dc9-9370-22ba9db773eb`, contains 28,738 characters and the subsequent compose job `71e1c739-1088-4ccb-9ecb-9f38147561da` copies that revised content. The revision preserves the Next.js/deployment restrictions and adds explicit A→B→A and complete post-victory state assertions. Older recovery missions repeatedly reviewed the prior composition; several revisions failed with bounded-context errors. A later required review was denied because it did not fit the mission allowance.

`tests/fixtures/take-eleven-specification-696.json` retains the actual relevant saved artifacts, all ten completed specification reviews, reviewed research, mission accounting, timestamps and source IDs. Provider diagnostics and duplicated draft-blind criteria are omitted from the fixture; original production records remain untouched.

## Correction

- Resolve the latest valid completed compose/revise artifact by completion time from the actual project lineage. Retain diagnostics for newer invalid drafts; never silently regenerate when a saved checkpoint fails validation.
- Pass an immutable project-bound source reference and content hash, rather than another 28K-character copy, through the durable mission evidence. Hydrate and validate it before any inference. Preserve all substantive historical review findings and complete reviewed research. Remove only byte-equivalent duplicate summary text.
- Use the existing compose → independent review → one revision → final independent review lifecycle, with the existing exact scope approval boundary. No review verdict or coding approval is fabricated or inferred from a checkpoint.
- Refuse an equivalent candidate's second recovery attempt for the same authoritative objective and user clarifications, even if it is copied under another assignment ID or receives new reviewer wording. Both the worker and locked SQL gate use the same canonical `recoveryKey`; SQL derives it from persisted scope, never caller evidence. Explicit requirement or clarification changes permit a separately budget-fenced recovery of the retained candidate. Older source-hash-only receipts cannot veto a changed scope. The original artifacts, receipts and charges stay recorded.
- Ordinary specification review strips checkpoint transport and historical review collections from `projectEvidence`, supplies substantive historical findings exactly once through `priorFindings`, and retains the complete current candidate and reviewed research. Recovered ordinary review and revision use a bounded 96K-character input envelope; ordinary composition input, 6K composition/revision output, and 5K review output ceilings remain unchanged. Native token counting, cumulative 24K review/40K revision admission and all future-stage reservations still apply. Inputs beyond that envelope stop before inference without dropping saved findings. The regression exercises both immediate approval and a complete changes-requested → revision → final-review cycle.
- Admit all mandatory specification stages together: fresh composition 30K when needed, independent review 24K, one revision 40K, final review 24K, plus 2K coordination headroom. Recovery therefore requires 90K; fresh specification requires 120K. These are hard ceilings, not spending targets or calibrated predictions. Each stage's ceiling includes its routing and retries. Native input counting and the original atomic reservation/settlement functions remain authoritative.
- Preserve additional project headroom and mission slots for every planned development milestone and whole-project assessment, using the existing 120K child ceiling. This planning headroom is not recorded as a charge or additional authorization. Insufficient tokens or slots produce an explicit blocker before a child is created.
- Check routing and execution against the same cumulative per-job stage accounting. Completed actual usage is charged; uncertain reservations remain charged. A router cannot consume a later mandatory stage's allowance. The fixed specification review contract keeps all six acceptance checks with a 5K output ceiling.

The SQL migration extends the existing completion gate in place and adds a read-only, backend-only stage capacity query. It does not change Native/Thin execution, provider routing policy, budgets, deadline authorizations, saved project artifacts, or historical charges. No production data backfill or automatic project restart is included.

## Verification

Run:

```bash
npm run typecheck
node --test tests/specification-lifecycle.test.mjs tests/game-specification-envelope.test.mjs tests/game-specification-lossless-bound.test.mjs tests/missions-runtime.test.mjs tests/projects-runtime.test.mjs
# Requires the same isolated PostgreSQL fixture server as existing CI:
node --test tests/projects-sql.test.mjs
```

The controlled runtime tests use the actual artifacts and all ten reviews. They prove zero model calls for checkpoint reuse; valid game and ordinary-software recovery; preservation of research and review findings; a complete repair/review cycle; bounded retry behavior; full-history evidence below the actual 60K database limit and model input below 96K; truthful persistence errors; and routing/execution stage admission.

The SQL fixture exercises the real completion gate, wrong-lease and foreign-checkpoint rejection, resource/mission-slot refusal, unchanged historical actual/reserved amounts, cumulative routing and uncertain-call accounting, equivalent-recovery rejection, refusal of unreviewed approval, and progression through the existing exact scope approval boundary. With its registered repository fixture, it also verifies owner approval advances to development without a new grant.

The migration and SQL fixture were additionally executed against staging `iytvavgbaainnsrecmcx` inside a single transaction ending in `ROLLBACK`. The fixture passed. A subsequent check found no retained fixture actors and no retained new function. No paid inference or benchmark launch occurred. This validates the SQL correction; it does not claim the historical project ran successfully in production.

Independent reviews identified routing headroom, full-history envelope, ordinary-spec reuse, persistence-error classification, authoritative-context deduplication and duplicate ordinary-review history defects. Each correction has regression coverage. The final ordinary-review regression uses all ten persisted reviews and the validated saved specification with only its optional `game` field removed; it exercises actual independent review dispatch, rather than checkpoint composition alone. The SQL fixture checks identical-scope refusal, separately changed objective/clarifications, caller-key spoofing refusal, cross-language recovery-key parity, preserved historical charges and the existing explicit approval boundary.
