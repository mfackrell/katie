# Executive Orchestrator: Specialist Registry and Universal Delegation Contract

This is a **management-plane interface**, not a software-development engine. Katie's executive layer owns user outcomes, decides which specialist has the necessary capabilities, establishes budgets/deadlines/acceptance evidence and independently accepts the resulting deliverable. Specialists own their internal agents, processes, technical infrastructure and troubleshooting.

## Specialist record
`executive_orchestrators` defines `slug`, title, description, capabilities, version, status, autonomy and adapter. **Registration alone confers no new permissions** and never invokes an external endpoint. The `mission` adapter represents an existing Katie mission capability; `external` is a named future adapter binding, not an arbitrary URL or shell command.

The Executive Orchestrator must not inspect a specialist's internal coding tools or workflow. The separate Software Development Orchestrator may later register `software_development` with capabilities such as `web_application_delivery`, `testing`, and `repository_maintenance` through this interface, without the executive changing its internal implementation.

## Universal delegation
A delegation has a stable request/correlation key, objective, capability, success criteria, budget (including zero), deadline and pinned specialist version. Status follows:
`proposed → accepted → running → submitted → verified`; `submitted → rejected` or an appropriate cancellation is permitted. Each transition is audited, with separate actor/chat identity checks, budgets, and timestamps.

A specialist report includes `delegationId`, progress, summary, structured evidence, deliverable or blocker. A specialist's **submitted** result is NOT automatically verified; acceptance requires independent executive review of the original success criteria. A blocked or missing output cannot be silently called successful.

The executive may later add adaptive routing, provisioning, orchestration-to-orchestration transport, escalation, and capability performance history without modifying these base contracts.

## Boundaries and next stages
This stage implements **registration, durable delegation definitions, transition fencing, cross-actor isolation, type-safe contracts, deterministic capability selection, and a read-only registry API**. It does **not** yet launch a newly registered specialist or provision new software. Those are explicit subsequent tasks; no work is secretly transferred to the Software Development Orchestrator.

A new specialist's code, API, permissions, credential provisioning, test execution, and release remain the responsibility of its own owner/specialist and existing authorization workflow.
