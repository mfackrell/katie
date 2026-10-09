"""Independent RunPod smoke test: health, synthetic GPU inference, or private video.

Examples:
  RUNPOD_API_KEY=... RUNPOD_ENDPOINT_ID=... python scripts/smoke_runpod.py --health
  RUNPOD_API_KEY=... RUNPOD_ENDPOINT_ID=... python scripts/smoke_runpod.py --self-test
  RUNPOD_API_KEY=... RUNPOD_ENDPOINT_ID=... python scripts/smoke_runpod.py --input local-private-request.json

This script does NOT contact Katie or save files to Supabase.
Do not commit real signed URLs or secrets to source control.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

ENDPOINT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,80}$")


def main() -> int:
    parser = argparse.ArgumentParser(description="Independent RunPod video worker smoke test")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--health", action="store_true", help="Quick worker-health test (no model loaded)")
    mode.add_argument("--self-test", action="store_true", help="GPU inference using synthetic footage")
    mode.add_argument("--input", type=Path, help="Request JSON for a signed private video")
    args = parser.parse_args()
    api_key = os.getenv("RUNPOD_API_KEY", "").strip()
    endpoint_id = os.getenv("RUNPOD_ENDPOINT_ID", "").strip()
    if not api_key or not ENDPOINT_ID_RE.fullmatch(endpoint_id):
        print("Set RUNPOD_API_KEY and a valid RUNPOD_ENDPOINT_ID in the environment")
        return 2
    if args.health:
        body = {"input": {"operation": "health"}}
    elif args.self_test:
        body = {"input": {"operation": "self_test"}}
    else:
        body = json.loads(args.input.read_text())
        if not isinstance(body, dict) or not isinstance(body.get("input"), dict):
            print("Input JSON must be an object with an 'input' object")
            return 2
    api = f"https://api.runpod.ai/v2/{endpoint_id}"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    # A remote job is asynchronous. Do not wait inside a Vercel request.
    submission = requests.post(f"{api}/run", headers=headers, json=body, timeout=30)
    submission.raise_for_status()
    job_id = submission.json().get("id")
    if not job_id:
        print("RunPod returned no job ID")
        return 1
    print("RunPod job submitted. Job ID:", job_id)
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        time.sleep(5)
        poll = requests.get(f"{api}/status/{job_id}", headers=headers, timeout=30)
        poll.raise_for_status()
        result = poll.json()
        status = result.get("status")
        print("RunPod job status:", status)
        if status == "COMPLETED":
            output = result.get("output")
            if not isinstance(output, dict):
                print("Unexpected worker output")
                return 1
            # Avoid printing content, tokens, or signed URLs.
            print("Worker status:", output.get("status"))
            print("Schema:", output.get("schema_version"))
            print("Model:", output.get("model") or output.get("gpu_model_configured"))
            print("Frames sampled:", output.get("frames_sampled", 0))
            print("Processing seconds:", output.get("processing_seconds"))
            if args.health:
                return 0 if output.get("status") == "healthy" and output.get("ffmpeg_available") else 1
            return 0 if output.get("status") == "completed" and output.get("frames_sampled", 0) > 0 else 1
        if status in {"FAILED", "CANCELLED", "TIMED_OUT"}:
            print("Remote execution did not complete successfully")
            return 1
    print("Timed out waiting for remote job")
    return 1


if __name__ == "__main__":
    sys.exit(main())
