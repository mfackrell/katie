# Native engineering runtime benchmark gateway (#715)

This is an SDK runtime **integration seam**, not an operational paid launch.

The native runner deliberately keeps the coding runtime's repository tools, sandbox, working directory and resumable session architecture. It uses the official Codex SDK's `startThread` / `runStreamed` semantics and requires a dedicated HTTPS upstream gateway.

A JavaScript field `attested:true` is only an adapter assertion, **not cryptographic or account-bound attestation**. Do not set the flag or execute paid work until the gateway service itself is implemented and verified.

## Must implement before launching
1. Deploy a gateway that owns the provider credential. No direct provider credential may be accessible to the coding process.
2. Authenticate an immutable experiment, arm, actor and approved account for every inbound request.
3. Determine actual request token usage or a conservative reserved bound, then atomically reserve in Supabase BEFORE forwarding every provider request. An output limit must also be enforced upstream; caller limits are not enough.
4. Store provider request ID, immutable response/usage receipt, model/pricing version, cost, cache/reasoning breakdown and uncertain holds. Support idempotent retries and overrun reconciliation (#739).
5. Restrict gateway egress to supported provider API routes and disallow bypass through other SDK/provider credentials. Independently security-test network isolation and approved workspace permissions.
6. Reconcile gateway charges before considering the native run completed. SDK turn usage is informational and may be cumulative on resumed turns.
7. Pin the native SDK dependency in package lock and invoke with a trusted SDK factory; this branch does not add it yet.
8. Use the SAME SDK, tools, model, baseline, artifact acceptance and provider gateway across native/thin/full arms. Only coordination differs.

Do not treat passing mocked tests as proof of a hard cap or completion of the three-arm benchmark. Do not deploy the benchmark without explicit owner spending approval.
