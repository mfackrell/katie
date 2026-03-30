# Architecture

## Frontend structure
- `app/page.tsx` is the main client entrypoint.
- `components/sidebar.tsx` handles actor/chat navigation and CRUD controls.
- `components/chat-panel.tsx` handles message rendering, model override UI, file upload flow, and streaming updates.
- Actor creation/editing is handled in `components/actor-form-modal.tsx`.

## Backend/API structure
API routes live under `app/api`:
- `chat/route.ts`: orchestration endpoint for model/provider selection, context assembly, generation, streaming, and persistence updates.
- `actors/route.ts`: actor CRUD.
- `chats/route.ts`: chat CRUD.
- `messages/route.ts`: message retrieval for a chat.
- `models/route.ts`: provider model discovery.
- `upload/route.ts`: file parsing + provider-specific upload references.

## Routing/provider selection overview
- Provider instances are assembled in `lib/providers/index.ts` from configured API keys.
- `lib/router/master-router.ts` selects provider/model using overrides, intent, and policy controls.
- Optional policy mode is implemented in `lib/router/policy-engine.ts` behind env flags.
- Video attachments are constrained by `lib/chat/video-routing.ts` to Google-compatible paths.

## Persistence/data model overview
- Main persistence module: `lib/data/persistence-store.ts`.
- DB access helper: `lib/data/supabase/admin.ts` (PostgREST-style client using Supabase URL + service role key).
- Entities persisted: actors, chats, messages, and three memory layers.

## Upload/file handling overview
- `/api/upload` validates multipart uploads and allowed file types.
- `lib/uploads/build-file-references.ts`:
  - validates file counts/sizes/types,
  - creates text/video previews,
  - optionally uploads files to OpenAI/Google for provider-native references.

## Memory/summary model overview
- Memory assembly: `lib/memory/assemble-context.ts`.
- Memory layers loaded into prompt context:
  - short-term memory,
  - intermediate memory (includes rolling summary),
  - long-term memory.
- Summary updates: `lib/memory/summarizer.ts` updates intermediate summary every N messages (when OpenAI key is available).

## Where core business logic lives
- Chat orchestration flow: `app/api/chat/route.ts`.
- Routing decision logic: `lib/router/*`.
- Provider behavior and API adaptation: `lib/providers/*`.
- Durable data operations: `lib/data/persistence-store.ts`.
