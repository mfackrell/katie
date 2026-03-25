# Routing Policy Engine

Katie now supports a policy-driven router behind feature flags.

## Flags

- `ROUTER_POLICY_ENGINE_ENABLED`: enables policy engine path.
- `ROUTER_POLICY_SHADOW_MODE`: when `true`, policy computes + logs trace but legacy router remains live.

## Core policy controls

- `ROUTER_POLICY_HARD_CAP_USD_PER_REQUEST`
- `ROUTER_POLICY_SOFT_CAP_USD_PER_REQUEST`
- `ROUTER_POLICY_MAX_COST_MULTIPLIER_VS_CHEAPEST`
- `ROUTER_POLICY_WEIGHT_CAPABILITY`
- `ROUTER_POLICY_WEIGHT_QUALITY`
- `ROUTER_POLICY_WEIGHT_LATENCY`
- `ROUTER_POLICY_WEIGHT_COST`
- `ROUTER_POLICY_AMBIGUITY_MARGIN_RATIO`

## Behavior

1. Existing routing path remains baseline compatibility path.
2. Policy engine evaluates intent + capability + cost + latency + quality.
3. In shadow mode, router logs `RouterPolicyTrace` with would-have-selected model.
4. In enforced mode, policy-selected model is used.
5. If metadata/candidates are missing, router stays on existing selection path.

## Trace shape

Structured trace includes intent, complexity, scored candidates, policy flags, penalties, selected model, runner-up model, and mode (`shadow` or `enforced`).
