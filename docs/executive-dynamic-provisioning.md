# Executive Dynamic Specialist Provisioning

This layer is owned by Katie's **Executive Orchestrator**. It never manages the Software Development Orchestrator's coding agents, CI pipelines, internal repair logic, or private tools.

A requirement is evaluated against the verified specialist registry:

- **Reuse** an *active* specialist whose capability contract already covers the objective.
- **Configure** a new registry entry using only existing *active, verified* mission capabilities. Registration alone is not activation. Independent capability acceptance is required.
- **Commission** missing capabilities through an already active specialist advertising `specialist_build`. This produces a durable, owner-bound request and requires a separately verified executive delegation, independent validation, and activation. It does **not** silently create code, credentials, endpoints, or permissions.

The capability decision is deterministic and independent of specialist internals. Requests are idempotent by actor, chat and request key, with recorded requirements and event history. The system will fail closed on stale approvals, unverified tests, absent builder capabilities, or a mismatched actor/chat.

Stages: `proposed → configured → validated → activated` for configuration, or `commission_pending → commissioned → validated → activated` for commissioned specialties. Commissioned software remains under its owner's established release authorization.

**Integration status:** The management service and PostgreSQL transitions can plan and configure. Automatic construction and activation of previously nonexistent execution adapters requires the Software Development Orchestrator to expose a registered, tested, executive-compatible builder capability. This work makes no assumptions about its implementation.

Do not call a proposed registration a working specialist. A completed specialist must have an independently verified acceptance result and an active, authorized adapter.
