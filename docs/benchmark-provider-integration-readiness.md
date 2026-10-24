# Benchmark execution readiness — issue #715

## Implementation evidence
- Katie mission provider path: `lib/missions/model.ts` already reserves via `reserve_mission_routing_call` before invoking the model and completes through `finish_mission_call`. Those reservations are mission-scoped, not tied to a separate benchmark ledger; adding an independent in-memory accounting wrapper would double-count or misrepresent enforcement.
- Direct engineering path: `.github/workflows/autonomous-development.yml` executes `openai/codex-action@v1` four times. No verified provider-level pre-request admission hook has been exposed by that action in the checked implementation.
- Shared `meteredRequest` and `BenchmarkBudget` contracts exist, but neither actual engine consumes those contracts yet.
- `owner-grant.mjs` validates a trusted, persisted owner approval shape; **no server-side approval table, owner identity lookup, atomic redemption, or authorization endpoint has been connected.**

## What qualifies as integration
1. Use one server-side durable ledger for **both** engines, keyed by experiment, arm, call ID, and approval version. Atomic reservations before sending requests; immutable actual consumption and reconciliation receipts; ambiguous errors retain holds.
2. Replace/wrap the direct Codex Action execution with an agent interface exposing each model request and model usage. Merely setting an action-wide token budget is insufficient if the action can exceed it while running.
3. Bind Katie missions to an isolated benchmark project and funding bucket. Reuse existing mission accounting rather than layering an unrelated non-durable counter.
4. Fetch the owner from trusted project records, accept only explicit user-approved increase records, atomically consume once, retain spent and pending reservations. Never infer approval from workflow inputs or model output.
5. Replay non-billable provider mocks against both actual dispatch layers, then run two matched bounded paid arms with separate branches and independent browser acceptance.
6. Until these are complete, `BENCHMARK_ENABLE_PAID` remains disabled and **NO paid A/B claim is warranted**.

## Current status
The shared interface and owner-grant validation have unit-level coverage only. They are NOT deployed integrations into both engines. Historical comparison remains observational, not a controlled experiment.
