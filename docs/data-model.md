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

## 7) persistent_directives
Stores directive records that are canonical for the managed directives block rendered into `actors.system_prompt`.
- `id`
- `user_id` (current identity anchor; ready to swap for stronger user identity later)
- `actor_id`
- `directive`
- `kind` (`style`, `workflow`, `business_context`, `constraint`, `preference`)
- `scope` (`actor` in v1, with optional `global`)
- `active`
- `created_at`, `updated_at`

## Relationships and flow
- Creating a chat provisions empty rows for all three memory tables.
- Chat orchestration reads actor + chat + recent messages + all memory layers.
- Assistant responses and user messages are appended to `messages`.
- Rolling summary updates write into `intermediate_memory.summary`.
- `persistent_directives` is source-of-truth for directive entries; the visible `actors.system_prompt` stores a managed block projection.
- Prompt precedence is: platform/system rules > current message instructions > persistent directives > default assistant behavior.
