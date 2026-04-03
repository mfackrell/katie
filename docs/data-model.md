# Data Model

This app persists chat state in Supabase-backed tables.

## Core entities

## 1) actors
Represents an actor persona.
- `id`
- `name`
- `system_prompt` (mapped to `purpose` in app types)
- `parent_actor_id` (optional parent-child actor relationship)
- `created_at`, `updated_at`

## 2) chats
Represents a conversation thread for one actor.
- `id`
- `actor_id` (FK-like relation to actors)
- `title`
- `created_at`, `updated_at`

Relationship: one actor has many chats.

## 3) messages
Represents chat messages in chronological order.
- `id`
- `actor_id`
- `chat_id`
- `role` (`user` or `assistant`)
- `content` (string; may encode text/model/assets as JSON string)
- `created_at`

Relationship: one chat has many messages.

## Memory storage concepts
Three per-(actor, chat) memory layers are persisted as JSON-like `content` payloads:

## 4) short_term_memory
- keyed by `actor_id` + `chat_id`
- stores recent/ephemeral context state

## 5) intermediate_memory
- keyed by `actor_id` + `chat_id`
- stores rolling summary (`summary`) and intermediate context

## 6) long_term_memory
- keyed by `actor_id` + `chat_id`
- stores longer-lived contextual memory

## 7) model_registry
Canonical model metadata + routing eligibility table populated automatically from provider discovery.
- identity: `provider_name`, `model_id`, `normalized_model_id` (PK includes provider + normalized ID)
- lifecycle: `first_seen_at`, `last_seen_at`, `discovered_at`, `is_active`
- pipeline statuses: `discovery_status`, `pricing_status`, `capability_status`
- routing controls: `routing_eligibility`, `confidence_score`, `confidence_tier`
- enriched metadata: pricing fields, capability booleans, reasoning/speed/cost tiers
- diagnostics/provenance: `source_metadata`, `failure_reason`, `exception_count`, verification timestamps

## 8) model_registry_refresh_runs
Background job audit trail for discovery/enrichment runs.
- `status` (`running | completed | failed`)
- `providers` and `summary` JSON payloads
- `started_at`, `finished_at`

## 9) model_registry_exceptions
Structured exception stream for provider/model failures.
- provider/model identifiers
- exception type/reason
- metadata payload
- `occurred_at`

## 10) model_registry_manual_overrides
Optional emergency override table (not required for normal operations).
- keyed by provider + normalized model ID
- override eligibility value
- notes + timestamps

## Relationships and flow
- Creating a chat provisions empty rows for all three memory tables.
- Chat orchestration reads actor + chat + recent messages + all memory layers.
- Assistant responses and user messages are appended to `messages`.
- Rolling summary updates write into `intermediate_memory.summary`.
- Model refresh jobs update `model_registry` and router consumes this table as primary model truth.
