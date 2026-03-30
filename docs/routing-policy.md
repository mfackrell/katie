# Routing Policy Engine

Katie supports a policy-driven router behind feature flags.

## Flags currently consumed by code
- `ROUTER_POLICY_ENGINE_ENABLED`: enables policy engine path.
- `ROUTER_POLICY_SHADOW_MODE`: when `true`, policy computes + logs trace but baseline router remains active.
- `ROUTER_POLICY_FALLBACK_ON_MISSING_METADATA`: fallback behavior toggle (defaults to enabled unless set to `false`).
- `ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST`: numeric per-request hard cap (default `0.12`).
- `ROUTER_POLICY_MAX_COST_MULTIPLIER_VS_CHEAPEST`: numeric multiplier threshold (default `3`).

## Additional routing trace metadata flags
- `ROUTER_TRACE_ENABLED`
- `ROUTER_POLICY_VERSION`
- `ROUTER_SCORING_POLICY_VERSION`

## Behavior
1. Existing routing path remains compatibility baseline.
2. Policy engine evaluates candidate metadata and constraints.
3. In shadow mode, policy computes/logs a trace and baseline selection is still used.
4. In enforced mode, policy-selected model is used.
5. If metadata/candidates are missing, selection falls back when configured.
