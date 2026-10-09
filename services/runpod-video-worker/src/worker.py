"""Standalone RunPod Serverless video-analysis worker for FFmpeg-decodable media.

The worker runs independently of Katie and accepts short-lived, signed URLs from
one configured private Supabase Storage origin. It does not require a separate
content-type attestation and has no adult-content-specific filter. Deployment
and submitted media must stay within the account's contractual authorization
and applicable law; the worker does not validate those external permissions.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlsplit

import requests

LOG = logging.getLogger("katie_video_worker")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

SCHEMA_VERSION = "1.0"
MAX_VIDEO_BYTES = 200 * 1024 * 1024
DEFAULT_MAX_VIDEO_SECONDS = 300.0
MAX_ANALYSIS_FRAMES = 48
MAX_FRAMES_PER_BATCH = 6
SUPPORTED_VIDEO_CONTAINERS = "Any container and codec FFmpeg can decode (including MP4, MOV, MKV, WebM, AVI, M4V, MPEG, TS, FLV, WMV)"
MAX_VIDEO_SECONDS_LIMIT = 600.0
DOWNLOAD_CHUNK = 1024 * 1024
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class InputError(ValueError):
    """A user-supplied job failed validation; no video should be processed."""


class ProcessingError(RuntimeError):
    """Failed to process a validated video; not a content-policy reroute signal."""


@dataclass(frozen=True)
class VideoJob:
    attachment_id: str
    source_url: str
    duration_limit_seconds: float
    max_frames: int
    transcribe_audio: bool
    expected_sha256: str | None


@dataclass(frozen=True)
class Sample:
    timestamp_seconds: float
    path: Path


class Analyzer(Protocol):
    model_id: str

    def describe(self, samples: list[Sample]) -> str: ...

    def summarize(self, segments: list[dict[str, Any]]) -> str: ...


def _required_storage_host() -> str:
    host = os.environ.get("ALLOWED_STORAGE_HOST", "").strip().lower()
    if not host or "/" in host or ":" in host or "@" in host or host.startswith("."):
        raise RuntimeError("ALLOWED_STORAGE_HOST must be an exact HTTPS hostname; e.g. project.supabase.co")
    # Prevent remote workers being configured to accept arbitrary URL hosts.
    if not (host.endswith(".supabase.co") or host.endswith(".storage.supabase.co")):
        raise RuntimeError("ALLOWED_STORAGE_HOST must be a specific Supabase Storage host")
    return host


def _validate_private_url(url: str, allowed_host: str) -> None:
    """Reject SSRF, public-object links and redirects before downloading media."""
    if len(url) > 4096:
        raise InputError("source_url too long")
    try:
        parsed = urlsplit(url)
        port = parsed.port  # port validation may raise ValueError
    except ValueError as exc:
        raise InputError("Invalid source_url") from exc
    if parsed.scheme != "https" or parsed.hostname != allowed_host or port not in (None, 443):
        raise InputError("Video source must be an HTTPS signed URL from the configured private storage host")
    if parsed.username or parsed.password or parsed.fragment:
        raise InputError("URL credentials and fragments are not accepted")
    if not parsed.path.startswith("/storage/v1/object/sign/katie-attachments/"):
        raise InputError("Video source must be a signed URL in the private katie-attachments bucket")
    # A signed download must have a token query parameter; never accept public buckets.
    if not parse_qs(parsed.query).get("token"):
        raise InputError("Missing Supabase signed URL token")


def parse_job(payload: Any) -> VideoJob:
    if not isinstance(payload, dict):
        raise InputError("input must be an object")
    attachment_id = payload.get("attachment_id")
    if not isinstance(attachment_id, str) or not SAFE_ID_RE.fullmatch(attachment_id):
        raise InputError("Invalid attachment_id")
    source_url = payload.get("source_url")
    if not isinstance(source_url, str):
        raise InputError("source_url must be a signed HTTPS URL")
    _validate_private_url(source_url, _required_storage_host())
    seconds = payload.get("max_duration_seconds", DEFAULT_MAX_VIDEO_SECONDS)
    if isinstance(seconds, bool) or not isinstance(seconds, (float, int)) or not 1 <= seconds <= MAX_VIDEO_SECONDS_LIMIT:
        raise InputError("max_duration_seconds must be between 1 and 600")
    max_frames = payload.get("max_frames", 32)
    if isinstance(max_frames, bool) or not isinstance(max_frames, int) or not 2 <= max_frames <= MAX_ANALYSIS_FRAMES:
        raise InputError("max_frames must be an integer between 2 and 48")
    transcribe_audio = payload.get("transcribe_audio", False)
    if not isinstance(transcribe_audio, bool):
        raise InputError("transcribe_audio must be boolean")
    expected_hash = payload.get("expected_sha256")
    if expected_hash is not None and (not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash)):
        raise InputError("expected_sha256 must be a lowercase SHA256 hex digest")
    return VideoJob(attachment_id, source_url, float(seconds), max_frames, transcribe_audio, expected_hash)


def download_private_video(job: VideoJob, destination: Path) -> tuple[int, str]:
    """One bounded HTTPS download, with redirects disabled and no credential logging."""
    allowed_host = _required_storage_host()
    _validate_private_url(job.source_url, allowed_host)
    total = 0
    digest = hashlib.sha256()
    try:
        with requests.get(job.source_url, stream=True, timeout=(10, 90), allow_redirects=False,
                          headers={"Accept": "video/*,application/octet-stream"}) as response:
            if response.is_redirect:
                raise InputError("Signed video URLs may not redirect")
            response.raise_for_status()
            announced = response.headers.get("content-length")
            if announced:
                try:
                    size = int(announced)
                except ValueError as exc:
                    raise InputError("Invalid Content-Length") from exc
                if size > MAX_VIDEO_BYTES:
                    raise InputError("Video exceeds 200 MiB limit")
            with destination.open("wb") as output:
                for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > MAX_VIDEO_BYTES:
                        raise InputError("Video exceeds 200 MiB limit")
                    digest.update(chunk)
                    output.write(chunk)
    except requests.RequestException as exc:
        # Never include exception bodies/URLs: signed token is confidential.
        raise ProcessingError(f"Private video download failed ({type(exc).__name__})") from None
    if not total:
        raise InputError("Video source is empty")
    sha = digest.hexdigest()
    if job.expected_sha256 and sha != job.expected_sha256:
        raise InputError("Video hash does not match expected_sha256")
    return total, sha


def _run(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=timeout)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        # Never leak temp paths, video content or credentials in provider results.
        raise ProcessingError(f"Media processing failed ({type(exc).__name__})") from None


def probe_video(source: Path) -> tuple[float, bool, int, int]:
    result = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                   "-show_entries", "stream=codec_type,width,height", "-of", "json", str(source)], timeout=20)
    try:
        payload = json.loads(result.stdout)
        duration = float(payload["format"]["duration"])
        streams = payload.get("streams", [])
        videos = [s for s in streams if s.get("codec_type") == "video"]
        audios = [s for s in streams if s.get("codec_type") == "audio"]
        if not videos or not math.isfinite(duration) or duration <= 0:
            raise ValueError("No readable video stream")
        width = int(videos[0].get("width", 0))
        height = int(videos[0].get("height", 0))
        if width <= 0 or height <= 0 or width * height > 100_000_000:
            raise ValueError("Invalid video dimensions")
        return duration, bool(audios), width, height
    except (ValueError, KeyError, TypeError) as exc:
        raise InputError("File is not a valid decodable video") from exc


def sample_frames(source: Path, workdir: Path, duration: float, max_frames: int) -> list[Sample]:
    """Decode a single FFmpeg pass into bounded, timestamped JPEG samples.

    FFmpeg fps sampling samples across the timeline. Timestamps are approximate
    relative to the decoded start; callers must label coverage as 'sampled'.
    """
    target_fps = min(2.0, max_frames / duration)
    # Don't upsample duplicate frames from very short clips.
    fps = min(target_fps, 2.0)
    if fps <= 0:
        raise ProcessingError("Invalid frame sampling rate")
    frames_dir = workdir / "frames"
    frames_dir.mkdir()
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
        "-vf", f"fps={fps:.6f},scale=w='min(640,iw)':h=-2:flags=bicubic",
        "-frames:v", str(max_frames), "-q:v", "5", "-y", str(frames_dir / "frame-%04d.jpg")
    ], timeout=min(300, max(30, math.ceil(duration * 2))))
    files = sorted(frames_dir.glob("frame-*.jpg"))
    if not files:
        raise ProcessingError("FFmpeg decoded no usable frames")
    return [Sample(round(min(duration, (i + 0.5) / fps), 2), path) for i, path in enumerate(files)]


def extract_audio(source: Path, output: Path) -> None:
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
          "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", "-y", str(output)], timeout=150)


def transcribe_audio(source: Path, workdir: Path) -> list[dict[str, Any]]:
    """Optional CPU transcription avoids competing with GPU vision-model VRAM."""
    audio_file = workdir / "audio.wav"
    extract_audio(source, audio_file)
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise ProcessingError("Optional transcription dependency is unavailable") from exc
    model = WhisperModel(os.getenv("WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(audio_file), beam_size=3, vad_filter=True,
                                   condition_on_previous_text=False)
    return [{"start_seconds": round(s.start, 2), "end_seconds": round(s.end, 2), "text": s.text.strip()}
            for s in segments if s.text.strip()][:500]


class QwenAnalyzer:
    """Lazy GPU-backed Qwen2.5-VL model. One worker process can reuse weights."""

    def __init__(self):
        self.model_id = os.getenv("VISION_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")
        self._model = None
        self._processor = None

    def _load(self):
        if self._model is not None:
            return
        try:
            import torch
            from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
        except ImportError as exc:
            raise ProcessingError("GPU dependencies not installed") from exc
        if not torch.cuda.is_available():
            raise ProcessingError("A CUDA GPU is required for the vision model")
        self._processor = AutoProcessor.from_pretrained(
            self.model_id, min_pixels=256 * 28 * 28, max_pixels=768 * 28 * 28
        )
        self._model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            self.model_id, dtype=torch.bfloat16, device_map="auto"
        ).eval()

    def _generate(self, user_text: str, samples: list[Sample] | None = None, max_tokens: int = 200) -> str:
        self._load()
        assert self._model is not None and self._processor is not None
        import torch
        from PIL import Image
        images = []
        try:
            items: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
            for sample in samples or []:
                opened = Image.open(sample.path).convert("RGB")
                images.append(opened)
                items.append({"type": "image", "image": opened})
            messages = [{"role": "user", "content": items}]
            prompt = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self._processor(text=[prompt], images=images if images else None,
                                     padding=True, return_tensors="pt").to(self._model.device)
            with torch.inference_mode():
                output = self._model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
            trimmed = output[:, inputs.input_ids.shape[-1]:]
            return self._processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()
        finally:
            for image in images:
                image.close()

    def describe(self, samples: list[Sample]) -> str:
        order = ", ".join(f"image {i + 1} ~{s.timestamp_seconds:.1f}s" for i, s in enumerate(samples))
        return self._generate(
            "Describe observable events across these time-ordered images. "
            f"Timeline: {order}. Be concise and factual. Note visible objects, actions, "
            "scene changes and movement supported by differences between frames. "
            "Do not invent dialogue or unobserved events. Do not infer people's identities, "
            "legal ages, or consent. Say when coverage is insufficient.",
            samples, max_tokens=220,
        )

    def summarize(self, segments: list[dict[str, Any]]) -> str:
        text = json.dumps([{"time": [s["start_seconds"], s["end_seconds"]], "observation": s["description"]}
                           for s in segments], ensure_ascii=False)
        return self._generate(
            "Produce a concise factual overall summary of these sampled-frame descriptions. "
            "Preserve chronology, distinguish observed events from uncertainty, and never add "
            f"details unsupported by the descriptions. Data: {text}", max_tokens=260
        )


_ANALYZER: Analyzer | None = None


def get_analyzer() -> Analyzer:
    global _ANALYZER
    if _ANALYZER is None:
        _ANALYZER = QwenAnalyzer()
    return _ANALYZER


def _analyze_video_file(job: VideoJob, model: Analyzer, source: Path, folder: Path,
                        *, started: float, video_bytes: int, sha: str) -> dict[str, Any]:
    """Common analysis pipeline for private videos and internally generated GPU smoke footage."""
    if video_bytes > MAX_VIDEO_BYTES:
        raise InputError("Video exceeds 200 MiB limit")
    if job.expected_sha256 and sha != job.expected_sha256:
        raise InputError("Video hash does not match expected_sha256")
    duration, has_audio, width, height = probe_video(source)
    if duration > job.duration_limit_seconds:
        raise InputError(f"Video duration exceeds configured limit of {job.duration_limit_seconds:g}s")
    samples = sample_frames(source, folder, duration, job.max_frames)
    segments: list[dict[str, Any]] = []
    for index in range(0, len(samples), MAX_FRAMES_PER_BATCH):
        batch = samples[index:index + MAX_FRAMES_PER_BATCH]
        description = model.describe(batch)
        if not description:
            raise ProcessingError("Vision model returned an empty description")
        segments.append({
            "start_seconds": batch[0].timestamp_seconds,
            "end_seconds": batch[-1].timestamp_seconds,
            "sample_timestamps_seconds": [frame.timestamp_seconds for frame in batch],
            "description": description,
        })
    summary = model.summarize(segments)
    if not summary:
        raise ProcessingError("Vision model returned an empty overall summary")
    transcript = []
    audio_status = "not_requested"
    if job.transcribe_audio:
        audio_status = "not_present" if not has_audio else "completed"
        if has_audio:
            transcript = transcribe_audio(source, folder)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "completed",
        "attachment_id": job.attachment_id,
        "sha256": sha,
        "source_bytes": video_bytes,
        "model": model.model_id,
        "duration_seconds": round(duration, 2),
        "dimensions": {"width": width, "height": height},
        "coverage": "sampled",
        "frames_sampled": len(samples),
        "frame_timestamps_seconds": [s.timestamp_seconds for s in samples],
        "summary": summary,
        "segments": segments,
        "audio": {"present": has_audio, "status": audio_status, "transcript": transcript},
        "limitations": [
            "Visual analysis is derived from sampled frames, not continuous video observation.",
            "Frame timestamps are approximate.",
            "Identity, precise age, consent and events between sampled frames cannot be established from visuals alone.",
        ],
        "processing_seconds": round(time.monotonic() - started, 2),
    }

def process_video(payload: dict[str, Any], *, analyzer: Analyzer | None = None,
                  source_override: Path | None = None) -> dict[str, Any]:
    """Standalone path: private signed URL -> FFmpeg -> GPU -> JSON."""
    started = time.monotonic()
    job = parse_job(payload)
    model = analyzer if analyzer is not None else get_analyzer()
    with tempfile.TemporaryDirectory(prefix="katie-video-") as temp:
        folder = Path(temp)
        source = folder / "source.video"
        if source_override is not None:
            # Local tests only, NEVER enable source_override on a production endpoint.
            if os.getenv("ALLOW_LOCAL_VIDEO_TESTS") != "1":
                raise InputError("Local source override is disabled")
            shutil.copyfile(source_override, source)
            video_bytes = source.stat().st_size
            sha = hashlib.sha256(source.read_bytes()).hexdigest()
        else:
            video_bytes, sha = download_private_video(job, source)
        return _analyze_video_file(job, model, source, folder, started=started,
                                   video_bytes=video_bytes, sha=sha)


def self_test(*, analyzer: Analyzer | None = None) -> dict[str, Any]:
    """Independent RunPod GPU smoke test on harmless synthetic video, no Katie access.

    Tests the real FFmpeg and vision inference path on a running endpoint.
    No signed URL, Supabase credentials, external download or source material involved.
    """
    started = time.monotonic()
    model = analyzer if analyzer is not None else get_analyzer()
    with tempfile.TemporaryDirectory(prefix="runpod-self-test-") as temp:
        folder = Path(temp)
        source = folder / "generated.mp4"
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
              "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=5:duration=3",
              "-c:v", "mpeg4", "-q:v", "6", "-an", "-y", str(source)], timeout=30)
        job = VideoJob("synthetic-self-test", "", 10.0, 4, False, None)
        with source.open("rb") as video_stream:
            digest = hashlib.file_digest(video_stream, "sha256").hexdigest()
        result = _analyze_video_file(job, model, source, folder, started=started,
                   video_bytes=source.stat().st_size, sha=digest)
        result["test_type"] = "synthetic_video_gpu_inference"
        return result


def health() -> dict[str, Any]:
    """Quick, no-model-download readiness probe for the remote endpoint."""
    return {"schema_version": SCHEMA_VERSION, "status": "healthy",
            "ffmpeg_available": bool(shutil.which("ffmpeg")),
            "ffprobe_available": bool(shutil.which("ffprobe")),
            "gpu_model_configured": os.getenv("VISION_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct"),
            "max_video_bytes": MAX_VIDEO_BYTES,
            "max_video_seconds": MAX_VIDEO_SECONDS_LIMIT,
            "max_frames": MAX_ANALYSIS_FRAMES,
            "supported_video": SUPPORTED_VIDEO_CONTAINERS}


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """RunPod queue-based Serverless handler; never logs signed URLs or frames."""
    try:
        payload = event.get("input") if isinstance(event, dict) else None
        if not isinstance(payload, dict):
            raise InputError("input must be an object")
        operation = payload.get("operation", "analyze")
        if operation == "health":
            return health()
        if operation == "self_test":
            return self_test()
        if operation != "analyze":
            raise InputError("operation must be analyze, health, or self_test")
        return process_video(payload)
    except InputError as exc:
        LOG.warning("Video job rejected: %s", str(exc))
        return {"schema_version": SCHEMA_VERSION, "status": "rejected", "error": {"code": "INVALID_INPUT", "message": str(exc)}}
    except Exception as exc:
        # Worker must never echo URL/query, private paths, model inputs or raw traces.
        LOG.exception("Video job failed (%s)", type(exc).__name__)
        return {"schema_version": SCHEMA_VERSION, "status": "failed",
                "error": {"code": "PROCESSING_ERROR", "message": f"Worker could not complete analysis ({type(exc).__name__})"}}


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
