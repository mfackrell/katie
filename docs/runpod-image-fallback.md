# RunPod public image fallback

## Status
Integration uses RunPod's pre-deployed Public Endpoint for **FLUX.1 Schnell**. No additional GPU worker, custom Docker image, or `RUNPOD_IMAGE_ENDPOINT_ID` is required. Existing production `RUNPOD_API_KEY` enables the endpoint when the account has sufficient RunPod credits and permission to access Public Endpoints.

Official contract: https://docs.runpod.io/public-endpoints/models/flux-schnell

## Routing
Grok and Gemini remain primary image generators. Only after **both fail** does Katie attempt one RunPod image generation. The gate includes technical errors, invalid or empty generation results, and other non-policy failures. A success by Grok/Gemini stops fallback. Explicit content moderation or safety rejections are terminal, not rerouted. Requests requiring saved visual-identity references are excluded until the third model can reproduce those reference images.

Existing Qwen RunPod video analysis is separate and unchanged.

## Public endpoint contract
`POST https://api.runpod.ai/v2/black-forest-labs-flux-1-schnell/runsync`
```json
{"input":{"prompt":"A lighthouse on a rocky beach","width":1024,"height":1024}}
```
RunPod replies `{"status":"COMPLETED","output":{"image_url":"https://image.runpod.ai/...","cost":...}}` on success.

The returned URL expires in seven days. Katie downloads the bytes immediately **only** from the HTTPS host `image.runpod.ai`, refuses redirects, limits downloaded bytes to 12 MiB, checks PNG/JPEG/WebP signatures, and persists a private inline image asset for future conversation use.

This endpoint is usage-billed; the documented estimate for 1024×1024 FLUX Schnell is approximately $0.0025 per successful image as of October 2026. An account with insufficient credits or restricted API key access will receive a bounded error.

## Release checks
- RunPod is attempted only after Grok and Gemini both fail to generate.
- Explicit policy and content rejections never reroute.
- RunPod image response is validated and persisted (not a seven-day remote link).
- No SSRF via arbitrary image URLs and no RunPod key sent with CDN downloads.
- Current environment must have `RUNPOD_API_KEY`.
- Typecheck, test suite, production build, and preview deployment must be green.
- A live, non-sensitive fallback smoke is required to claim confirmed provider success.
