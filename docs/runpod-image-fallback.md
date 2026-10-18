# RunPod image-generation fallback (dual provider failures)

Status: integration code is feature-gated. It cannot run until a **separate image-generation RunPod endpoint** is provisioned and verified. The existing RunPod Qwen video-analysis endpoint is NOT an image generator and must not be reused.

## Routing

Katie uses Grok Imagine and Gemini for images as before. RunPod is selected **only if both have attempted the same request and both failed to generate** (timeouts, rate limiting, 5xx, invalid generation output and other non-policy errors). A success from either stops the chain. Any safety refusal, content moderation outcome, blocked request, or unsupported output is **never** eligible for RunPod rerouting. Image requests containing established face-reference images are currently excluded: dropping their identity bytes is not acceptable.

## Endpoint contract

A separately provisioned RunPod Serverless image worker must accept:

```json
{"input":{"prompt":"a non-sensitive image description"}}
```

and return its full image directly, matching RunPod's synchronous `/runsync` wrapper:

```json
{"status":"COMPLETED","output":{"images":[{"type":"base64","data":"<base64 PNG/JPEG/WebP>"}]}}
```

The client validates the returned image signature and max size (12 MiB), allows no remote image URLs or arbitrary hosts, and aborts on non-COMPLETED jobs. This is a specific worker contract, NOT a universal contract for every RunPod model. Default ComfyUI serverless workers often require an explicit workflow instead of a bare prompt; do not point this adapter at an unmodified ComfyUI endpoint without validating the input contract.

## Activation

- Existing secret `RUNPOD_API_KEY`: already used for video analysis; do not expose or duplicate its value.
- New production setting `RUNPOD_IMAGE_ENDPOINT_ID`: ID of the **tested image-generation worker**, not the Qwen video-analysis endpoint.

Do not activate without an image worker that actually implements this request and response contract and a live non-sensitive image smoke test. Do not merge based on mock tests alone. If the endpoint can accept visual identity references in the future, add an explicit separately tested image-reference contract before enabling those requests.

## Verification required

1. Grok success -> no Gemini/RunPod.
2. Grok technical failure + Gemini success -> no RunPod.
3. Grok generation failure + Gemini generation failure -> one RunPod attempt, including non-policy terminal errors.
4. Either provider safety/content refusal -> no RunPod attempt.
5. No configured endpoint -> preexisting routing only.
6. Endpoint errors/incorrect output return a bounded error; no untrusted URL fetch.
7. Production smoke with actual deployed image worker and release build, before enabling.
