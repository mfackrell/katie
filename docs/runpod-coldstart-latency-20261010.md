# RunPod native-video cold-start mitigation (2026-10-10)

## Scope

Standalone endpoint `yafwsm98e8m9lv`, official `runpod/worker-v1-vllm:v2.27.1` worker, `Qwen/Qwen3-VL-8B-Instruct`. This endpoint is NOT Katie's production video route; Gemini→Grok remains unchanged.

## Root cause and actual settings

At inspection, RunPod reported:
- `workersMin: 0`, `workersMax: 1` (flex GPU worker shuts down after idle).
- `flashboot: false` (snapshot-based restart optimization OFF).
- `scalerType: QUEUE_DELAY`, `scalerValue: 4`, `idleTimeout: 60`.
- GPU pool priority: RTX 6000 Ada 48GB, L40 48GB, L40S 48GB, A100 80GB variants.
- No network volume or persistent vLLM compile cache.
- vLLM template used `MAX_NUM_SEQS=1`, `MAX_MODEL_LEN=32768`, `GPU_MEMORY_UTILIZATION=0.90`.

Model execution itself took 8s on the first saved video; the 482s queue delay contained worker provisioning, vLLM startup and capacity wait.

## Applied to the live standalone RunPod endpoint

- Enable `flashboot=true`: permits process snapshots to resume instead of a fresh GPU/container/model boot when a compatible cached worker is available.
- Change scaler to `REQUEST_COUNT`, threshold `1`: allocate a worker promptly per pending request.
- Increase idle timeout to 300s: keep the expensive model warm for short bursts of follow-up requests; scale to zero when unused.
- Keep `workersMin=0` and `workersMax=1`: avoid the substantial 24/7 GPU charge.
- Add `SAFETENSORS_LOAD_STRATEGY=prefetch` to the dedicated v2 worker template `ykwdli9yfb` while preserving all pre-existing env keys. Affects subsequent worker starts.

## Tests

- Baseline original real-video job: `delayTime=482014ms`, `executionTime=8044ms`.
- Another full original-video job before optimization: `delayTime=230186ms`, `executionTime=70742ms`.
- First cold text-inference benchmark after enabling FlashBoot and request-count scaling: `delayTime=222274ms`, `executionTime=290ms` (cold-start penalty remains).
- Immediate follow-up warm request: `delayTime=26ms`, `executionTime=193ms`.
- After setting vLLM prefetch: warm request `delayTime=557ms`, `executionTime=227ms`.

Warm-request queuing is dramatically faster. This does **not** eliminate first-boot delays on a cold cache miss or scarce GPU host. Even FlashBoot can miss if a compatible snapshot is unavailable on the selected host.

## Explicit cost decision

Keeping `workersMin=1` eliminates cold starts, but would continuously bill a 48GB PRO / 80GB GPU even when nobody uses Katie. RunPod's 2026 rate for an active 48GB PRO worker is about $1.33/hour (roughly $970 per 730-hour month), and an A100 80GB active worker costs more. This was **not** enabled without a recurring-spend decision.

## Rollback and monitoring

To revert endpoint tuning via RunPod management API, set:
```json
{"flashboot":false,"scalerType":"QUEUE_DELAY","scalerValue":4,"idleTimeout":60,"workersMin":0,"workersMax":1}
```
If necessary, remove `SAFETENSORS_LOAD_STRATEGY` from template `ykwdli9yfb` using the v2 template PATCH API, preserving all other env keys.

Compare delayTime/executionTime on representative calls and check `/health` (especially `workers.throttled`) and the worker logs. Do not treat a warm benchmark as proof that all scale-from-zero cold starts are fixed. 
