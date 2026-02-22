# Katie Multi-LLM Orchestrator

Next.js 15 App Router application that orchestrates OpenAI + Gemini chat with a Tri-Layer Memory pattern persisted in Vercel Blob.

## Environment variables
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `MASTER_ROUTER_MODEL` (defaults to `gpt-4o`)

## Blob storage note
This project uses Vercel Blob with **public access** for all writes (`access: 'public'`) for Hobby-tier compatibility.

## Local development
```bash
npm install
npm run dev
```
