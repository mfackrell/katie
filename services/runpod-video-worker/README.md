# Standalone RunPod video-analysis worker for Katie (future integration)

**Status:** Standalone worker; local test suite available. **NOT deployed to RunPod; NOT GPU-tested; NOT connected to Katie.**
This standalone service lives under `services/runpod-video-worker/` on the `feature/runpod-video-worker` branch of `mfackrell/katie`. The existing Katie application code, Supabase database, and production Vercel configuration are untouched.

## What this service does

A queue-based RunPod Serverless Python worker accepts a private video by a short-lived signed URL, checks file and duration limits, samples up to 48 timestamped frames from any FFmpeg-decodable video container (including MP4, MOV, MKV, AVI, TS and WebM), runs Qwen2.5-VL-7B-Instruct to describe segments and summarize them, optionally transcribes speech with `faster-whisper` (CPU), and returns a structured JSON result. Video bytes, private frames, and signed tokens are not included in the response. The worker never writes to Katie's database or storage.

**Adult-content handling:** The worker has **no adult-content-specific input restriction, attestation requirement, or classification block**. It can analyze lawful adult videos to the extent the deployed model is capable. You have stated that your RunPod account has written permission for this use; ensure the specific deployment and activity fall within that written authorization before submitting any material. The worker does not verify account-level permission or independently determine age, consent, ownership, or legality. It does not bypass any restrictions applied by the vision model itself.

## What is built

- `src/worker.py`: working RunPod SDK handler, private-source download guard, FFmpeg video probing/decoding, frame sampling, Qwen2.5-VL model inference, optional Whisper audio, and structured JSON.
- `Dockerfile`: NVIDIA-compatible PyTorch/CUDA base with system FFmpeg.
- `tests/`: unit and end-to-end CPU tests using synthetic non-sensitive videos and a fake inference model; no GPU/download needed.
- `examples/input.json`: standalone request contract (values are placeholders).
- `scripts/smoke_runpod.py`: submit health, self-test, or a private-video job to a deployed endpoint and poll its status.
- `docs/integration-contract.md`: future integration requirements; **does not alter Katie**.

## Format acceptance and adult-content configuration

The worker has **no filename-extension, provider, or video-MIME allowlist**: it detects and analyzes video based on its actual decodable streams. MP4, MOV, MKV, AVI, MPEG-TS and WebM were verified by local tests. Other formats should work when their codec is supported by the deployed FFmpeg; this is not a claim that every possible container/codec on Earth is supported. File size is limited to 200 MiB, video duration to 600 seconds, and analysis to 48 frames.

**No adult-content gate is installed:** `content_policy_confirmed` is no longer part of the request schema. Older clients may still send it, but the worker ignores it. There are no keyword filters or pornographic-content detection/denial rules in the worker. Treat this as a content-neutral processing API, not a certification that any particular video is legal, consensual, or within an account's authorization. Security controls on private signed storage URLs and bounded media processing remain.

## Independent health / GPU smoke tests (no Katie access)

The worker includes two safe, self-contained operations:

- `{"input":{"operation":"health"}}` checks FFmpeg and FFprobe availability and reports limits without loading the GPU model.
- `{"input":{"operation":"self_test"}}` generates a harmless 3-second test-pattern video inside the worker and runs it through actual FFmpeg decoding and **real GPU vision inference**. This operation does not require any video upload or Supabase account access, so it should be the first remote end-to-end test.

Submit either operation to the RunPod `/run` endpoint or use the smoke client:

```bash
export RUNPOD_API_KEY=YOUR_SERVER_SIDE_KEY
export RUNPOD_ENDPOINT_ID=YOUR_ENDPOINT_ID
python scripts/smoke_runpod.py --health
python scripts/smoke_runpod.py --self-test
# For a separate private video, supply an uncommitted signed-URL request JSON:
python scripts/smoke_runpod.py --input local-private-request.json
```

The health test is a readiness check, *not* proof GPU vision is working. The synthetic self-test exercises the actual vision model, and only a completed remote call can validate GPU execution.

## Job request contract

When deployed as a RunPod **queue-based** Serverless endpoint, submit `POST /run` with:

```json
{
  "input": {
    "attachment_id": "example-123",
    "source_url": "https://YOUR_PROJECT.supabase.co/storage/v1/object/sign/katie-attachments/chats/CHAT_ID/FILE_ID.source?token=SIGNED_TOKEN",
    "max_duration_seconds": 300,
    "max_frames": 32,
    "transcribe_audio": false,
    "expected_sha256": "OPTIONAL_64_CHAR_LOWERCASE_HEX_SHA256"
  }
}
```

Delete `expected_sha256` entirely if unknown. URLs **must** be HTTPS, include a valid Supabase signed token, and reside in the configured `katie-attachments` private bucket. The worker does not accept URLs from arbitrary domains, public buckets, redirect targets, or credentials in URLs. Do not log the signed URL.

A completed response returns `status`, `schema_version`, `attachment_id`, `sha256`, `model`, `duration_seconds`, `dimensions`, `frames_sampled`, `frame_timestamps_seconds`, `coverage: "sampled"`, `summary`, `segments`, `audio`, `limitations`, and `processing_seconds`.

Errors return `status: "rejected" | "failed"` with a fixed error code. Integration code must check `output.status` **even when RunPod reports its job as COMPLETED**.

## Run the local tests (does NOT use RunPod)

From the Katie repository root first change into `services/runpod-video-worker` (`cd services/runpod-video-worker`).

Install Python 3.10+ and FFmpeg/FFprobe. From the project folder:

```bash
python -m pip install -r requirements-test.txt
python -m pytest -q
python -m compileall -q src
```

The tests generate a synthetic color-pattern video and call `process_video` with a stubbed vision model, validating the JSON schema, private URL restrictions, size limits, decoding, and errors.

## How to deploy *after* access to RunPod is available

1. **Confirm your RunPod account's written authorization covers the intended deployment and media.** The worker does not check those authorization documents.
2. Use the existing `mfackrell/katie` repository branch `feature/runpod-video-worker`. RunPod must build with **context `services/runpod-video-worker`**, not the Next.js repository root. Do not put RunPod credentials in GitHub source.
3. Build an `linux/amd64` Docker image from the worker subdirectory and push it to a container registry. GitHub-origin builds are suitable only when the RunPod integration can select that subdirectory as the build context. From the **Katie repository root**, run:

   ```bash
   docker build --platform linux/amd64 -f services/runpod-video-worker/Dockerfile -t YOUR_REGISTRY/katie-video-worker:v0.1.0 services/runpod-video-worker
   docker push YOUR_REGISTRY/katie-video-worker:v0.1.0
   ```

4. Create a **queue-based Serverless** endpoint in the RunPod console using that image. For the first benchmark choose a GPU with **at least 48 GB VRAM** (e.g. L40S or A6000), `min workers = 0`, `max workers = 1`, 600s execution timeout, sufficient container disk (at least 50 GB), and one job per worker. Confirm exact current GPU availability/pricing in your account.
5. Configure the RunPod worker environment variable:

   ```text
   ALLOWED_STORAGE_HOST=YOUR_PROJECT.supabase.co
   VISION_MODEL=Qwen/Qwen2.5-VL-7B-Instruct
   WHISPER_MODEL=small
   LOG_LEVEL=INFO
   ```

   **Do not set** `ALLOW_LOCAL_VIDEO_TESTS=1` in production. No Supabase service-role key is needed on RunPod. Ensure the HF model cache path is writable; `HF_HOME` defaults to `/root/.cache/huggingface` in the Dockerfile; set it to `/runpod-volume/huggingface` only when a mounted writable network volume exists. Cached model weights improve cold start performance.
6. **First run the `--health` and `--self-test` smoke commands after deployment.** These require no Supabase credentials or files, and establish that the actual GPU inference path works. Then generate a **short-lived signed URL** for a video you are authorized to process in the private bucket, expiring long enough for queue delays and worker start. Do not use a public video link. For independent deployment testing, create the signed URL in the Supabase dashboard or an external test script; Katie must not be modified.
7. To analyze a permitted video, run the independent client:

   ```bash
   export RUNPOD_API_KEY=YOUR_SERVER_SIDE_KEY
   export RUNPOD_ENDPOINT_ID=YOUR_ENDPOINT_ID
   python scripts/smoke_runpod.py --input local-private-request.json
   ```

   Replace the placeholder URL in the JSON file before invoking. Never commit actual signed tokens.
8. Verify JSON schema, frame-count limits, model identification, and result quality using test videos you have rights to process. Run GPU performance tests and check cost/cold start before increasing concurrency.

RunPod API instructions: https://docs.runpod.io/serverless/quickstart and https://docs.runpod.io/serverless/endpoints/operation-reference. Qwen model info: https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct.

## Privacy and limitations

- RunPod receives a temporary URL to the original video; signed URLs are bearer credentials until expiration. Use a private bucket, short lifetimes, least-privilege service credentials on the signing side, and do not include tokens in logs.
- Queue payloads may be retained in provider control planes according to their policies; do not assume they are private solely because the storage bucket is private.
- FFmpeg processes video only in a temporary worker directory that is deleted after every job.
- Sampling does **not** provide continuous tracking of every video frame. Results explicitly say sampled and list the timestamps used.
- Inference can be inaccurate; it must not be relied upon to determine identity, legal age, consent, or events not present in sampled frames.
- The worker's generated summary is not a raw source of truth; Katie should retain the original video and only cite claims supported by actual analyzed evidence.
- There is no webhook that can update Katie. Nothing in this service writes to `public.messages` or other Katie tables.
- A model download and GPU verification have **not** yet been performed. Local CPU tests use a fake analyzer; the production inference path still requires an actual RunPod GPU deployment for end-to-end verification.

## What is deliberately NOT done

- New files are added only under `services/runpod-video-worker/` in the isolated `feature/runpod-video-worker` branch. No existing Katie runtime files, configurations, production branch, or connected services are modified.
- No Supabase migrations, new buckets, or database writes.
- No Vercel environment variable additions, routes, or deployments.
- No RunPod infrastructure charges or endpoint creation: **this session has no connected RunPod account/credential or Docker builder, so remote provisioning and remote tests are outstanding.**
