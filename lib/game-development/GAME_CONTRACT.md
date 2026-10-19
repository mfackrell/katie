# Game Development Agent — Game Rules & Acceptance Contract (v1)

This framework belongs to the dedicated Game Development Agent. It does **not** modify Katie's top-level orchestrator, global retries, budgets, permissions, database or deployment controls.

## Before coding

For every game, including an original game, build a versioned rules record understood by `validateGameRules` in `lib/game-development/rule-contract.mjs`:

- `game`: stable id, title, explicit edition, `kind` (original or reproduction).
- `sources`: id, kind (user, official, authorized_reference, other), reference, official edition when applicable. Cite source links and where applicable relevant page/rule numbers in reference text. A citation is not proof that the source was read.
- `rules`: stable id, description, category (setup/action/turn/phase/combat/randomness/information/victory/persistence/reset/ui/other), status (verified, approved_interpretation, unresolved), sourceIds. User-approved interpretations need a user decision source.
- `unknowns`: id, question, open/resolved status, blocking true/false, affected ruleIds, and decisionSourceId if resolved. No invented edition mechanics. A blocking unknown prevents the contract from becoming ready.
- `invariants`: stable id, description, ruleIds. Examples: illegal action preserves state; turn ownership rotates correctly; victory states become terminal; seeded outcomes replay deterministically.
- `stateModel`: JSON-serializable initialState and an explicit phases array (empty for a game with no phases).

Do not include unlicensed imagery, copied rulebook text, unsupported assumptions, or invented gameplay. Identify the source edition and contradictions before claiming fidelity.

## Acceptance evidence

Write a separate `acceptance` object with matching gameId, schemaVersion 1, and scenarios. Each scenario has id, description, kind, ruleIds, invariantIds and steps.

- **Model**: steps are `{action:{type,...},expectedState:{...}}`. Check every state snapshot exactly with `runGameModelAcceptance(spec,acceptance,realGameTransition)`. The transition must not mutate input state. Include illegal/boundary actions, phase changes, turn ownership, victory states, persistence-related transitions and seeded events as appropriate.
- **Browser**: steps follow the existing browser runner: goto(path), click(selector), fill(selector,value), expectVisible(selector), expectText(selector,value). Require visible assertions of gameplay. Browser scenarios must execute through the authorized real-browser harness against an actual built route and the immutable private Preview, with source-bound receipts.
- Every verified/approved rule needs acceptance coverage; unresolved rules cannot be claimed as passed. Preflight `contractReady` means the **contract is ready for execution**, not that the game is released.
- The model runner deliberately returns `browserChecks: 'NOT_RUN'` and `readyToRelease: false`. A green model receipt is never a substitute for real browser evidence.

Track each rule ID → source/edition → invariant → model/browser scenario → verified run ID and immutable commit. Report exactly which tests were executed and their results.

## Workflow / authority

1. Identify the correct game edition and user outcome.
2. Research primary evidence, identify unknowns and request decisions only when material.
3. Define the game rules, game-state model, acceptance scenarios, and bounded vertical slices.
4. Write rules separately from UI, networking, persistence and AI so the transition model can be tested deterministically.
5. Implement only authorized scope using existing draft-PR development and independent review.
6. Independently test the actual game. Report runnable preview, supported rules, remaining gaps, and user instructions.
7. Escalate infrastructure failures; do **not** recode a verified game simply because infrastructure crashed. Platform-wide orchestrator and CI ownership remain with other agents.

## The 3×3 regression fixture

`tests/game-rule-contract.test.mjs` demonstrates the contract with the user-approved rules of pilot `a03df077-9cf9-4e26-a819-fd40535b57e3` (historical final game commit `0720c514a14500535cbf50ee956066e237ab4e67`). This fixture checks the framework against **illustrative pure game logic**, not that immutable app's real browser runtime. The original pilot has separate browser acceptance and user verification for movement, reload persistence and reset.

This is **step 2** of [game-development specialist issue #553](https://github.com/mfackrell/katie/issues/553). A later, separate task should validate a new turn/phase mechanic using the dedicated Game Development Agent before attempting Fortress America.