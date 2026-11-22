# Katie owner sexual-boundary safeguard — owner approval pending

Owner decision recorded November 20, 2026. Do NOT merge, deploy, or perform database deletions without fresh owner authorization.

## Scope
- Authenticated owner-only chat workflow. Never use editable actor display names or personas as identity proof.
- Preflight refuse explicit erotic role-play, sexting and arousal-focused prompts before any model selection, including manually overridden models.
- Inject the owner rule into the shared provider parameter builder used by normal, collaboration and fallback providers. Ordinary romance, faith, recovery, trauma and health discussion remain available.
- Buffer owner text deltas until final screen passes. This trades owner-facing partial text streaming for protection against raw unsafe text leaking before validation. Retain progress and metadata.
- No UI/user-controlled switch disables the boundary.

## Destructive cleanup: not authorized
Do NOT run broad regex DELETE or UPDATE statements in production. Build an exact reviewed manifest of actor, chat, message, attachment and storage object identifiers. Distinguish sexual role-play from legitimate conversation about sex, relationships, consent, sexual health, abuse and quitting. Review both user and assistant turns.

Before any deletion:
1. Verify owner/chat/actor associations including guests; do not assume all actor records belong to the owner.
2. Inventory messages, chat_requests, short_term_memory, intermediate_memory, long_term_memory, actor_long_term_memory, actor_ltm_maintenance_history, actor_memory_calibration_backups, actor_memory_documents, visual_observation_corrections, visual_references, upload and generated-image metadata and physical object stores. Determine foreign keys and backup retention. Do not assume deleting a message removes derivatives.
3. Produce an owner-reviewable dry-run by exact IDs/table with counts but without publishing sensitive text.
4. Ask owner to confirm the exact manifest and collateral loss. Execute a tested transaction and supported object-store deletes only after authorization. Rebuild affected memory layers.
5. Verify by re-querying every live store. Disclose any backups, immutable logs or provider-side retention which cannot be immediately purged.

## Validation
Run npm run typecheck, npm test, npm run check:url, npm run build and npm run smoke. Require all GitHub PR CI jobs to conclude successfully before requesting merge authorization. Never auto-merge or auto-deploy.

## Residual risks
Deterministic text matching cannot perfectly classify veiled or visual sexual content. Server instructions and final-text screening add defense in depth, but perfect detection would require more advanced review and adversarial tests. Do not claim guaranteed protection.
