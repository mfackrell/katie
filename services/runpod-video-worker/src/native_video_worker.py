"""Native-video Qwen3-VL RunPod worker, independent of Katie's production router.

The original MP4/MOV is the model's video input. No FFmpeg JPEG extraction,
per-frame captioning, or image-array forwarding occurs in this worker.
Qwen's video processor internally performs temporal frame/token selection;
native-video input does not mean every source frame is consumed.
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Protocol

from . import worker as media

LOG = logging.getLogger("katie_native_video")
SCHEMA_VERSION = "2.0"
DEFAULT_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
MAX_NATIVE_VIDEO_FRAMES = 192
MIN_NATIVE_VIDEO_FPS = 0.15
MAX_NATIVE_VIDEO_FPS = 2.0


class VideoAnalyzer(Protocol):
    model_id: str

    def analyze_video(self, video_path: Path, duration_seconds: float, question: str) -> str: ...


def recommended_video_fps(duration_seconds: float) -> float:
    """Bound model context while distributing temporal tokens over the full file."""
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise media.InputError("Invalid video duration")
    return round(max(MIN_NATIVE_VIDEO_FPS, min(MAX_NATIVE_VIDEO_FPS,
                     MAX_NATIVE_VIDEO_FRAMES / duration_seconds)), 4)


class Qwen3NativeVideoAnalyzer:
    """Qwen3-VL: one video-typed multimodal request, NOT a list of JPEGs."""

    def __init__(self):
        self.model_id = os.getenv("VISION_MODEL", DEFAULT_MODEL)
        self._model = None
        self._processor = None

    def _load(self):
        if self._model is not None:
            return
        try:
            import torch
            from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
            from qwen_vl_utils import process_vision_info
        except ImportError as exc:
            raise media.ProcessingError("Native video model dependencies unavailable") from exc
        if not torch.cuda.is_available():
            raise media.ProcessingError("Qwen3-VL native video analysis requires CUDA")
        self._processor = AutoProcessor.from_pretrained(self.model_id)
        self._model = Qwen3VLForConditionalGeneration.from_pretrained(
            self.model_id, dtype=torch.bfloat16, device_map="auto"
        ).eval()
        self._process_vision_info = process_vision_info

    def analyze_video(self, video_path: Path, duration_seconds: float, question: str) -> str:
        self._load()
        assert self._model is not None and self._processor is not None
        import torch
        fps = recommended_video_fps(duration_seconds)
        # The file is passed as ONE native "video" content item; the official
        # Qwen processor handles temporal decoding, metadata, and visual tokens.
        messages = [{"role": "user", "content": [
            {"type": "video", "video": video_path.resolve().as_uri(),
             "fps": fps, "max_pixels": 256 * 256},
            {"type": "text", "text":
             "Analyze the VIDEO, not isolated still photographs. "
             "Describe the entire clip chronologically, including sustained "
             "actions, scene changes and important temporal relationships. "
             "Give approximate timestamps only when justified. "
             "Do not invent events, dialog, identities, ages, or consent. "
             "Acknowledge details too brief to determine. "
             "User request: " + question}
        ]}]
        template = self._processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        images, raw_videos, video_kwargs = self._process_vision_info(
            messages, image_patch_size=16,
            return_video_kwargs=True, return_video_metadata=True
        )
        if not raw_videos:
            raise media.ProcessingError("Video processor returned no video tokens")
        videos, metadata = zip(*raw_videos)
        batch = self._processor(
            text=[template], images=images, videos=list(videos),
            video_metadata=list(metadata), return_tensors="pt",
            do_resize=False, **video_kwargs
        ).to(self._model.device)
        with torch.inference_mode():
            output = self._model.generate(
                **batch, max_new_tokens=1400, do_sample=False
            )
        generated = output[:, batch.input_ids.shape[-1]:]
        analysis = self._processor.batch_decode(
            generated, skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )[0].strip()
        if not analysis:
            raise media.ProcessingError("Native video model returned empty analysis")
        return analysis


_ANALYZER: VideoAnalyzer | None = None


def get_analyzer() -> VideoAnalyzer:
    global _ANALYZER
    if _ANALYZER is None:
        _ANALYZER = Qwen3NativeVideoAnalyzer()
    return _ANALYZER


def analyze_video_file(
    job: media.VideoJob, source: Path, size: int, sha256: str,
    *, analyzer: VideoAnalyzer | None = None, started: float | None = None,
    question: str = "Describe what happens in this video."
) -> dict[str, Any]:
    began = started if started is not None else time.monotonic()
    duration, has_audio, width, height = media.probe_video(source)
    if duration > job.duration_limit_seconds:
        raise media.InputError("Video exceeds configured duration limit")
    model = analyzer or get_analyzer()
    analysis = model.analyze_video(source, duration, question)
    if not analysis or not analysis.strip():
        raise media.ProcessingError("Native video analysis was empty")
    audio: dict[str, Any] = {
        "present": has_audio,
        "status": "not_requested",
        "transcript": [],
    }
    if job.transcribe_audio:
        if has_audio:
            with tempfile.TemporaryDirectory(prefix="video-audio-") as temp:
                audio["transcript"] = media.transcribe_audio(source, Path(temp))
            audio["status"] = "completed"
        else:
            audio["status"] = "not_present"
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "completed",
        "attachment_id": job.attachment_id,
        "sha256": sha256,
        "source_bytes": size,
        "model": model.model_id,
        "analysis_mode": "native_video",
        "coverage": "video_with_temporal_sampling",
        "internal_video_processing_fps": recommended_video_fps(duration),
        "duration_seconds": round(duration, 2),
        "dimensions": {"width": width, "height": height},
        "analysis": analysis,
        "summary": analysis,
        "audio": audio,
        "limitations": [
            "The original video was supplied to a video-aware multimodal model.",
            "Its processor samples temporal video tokens; not every original frame is guaranteed to be used.",
            "Timestamp estimates and fine motion may be imprecise.",
        ],
        "processing_seconds": round(time.monotonic() - began, 2),
    }


def analyze_request(payload: dict[str, Any], *,
                    analyzer: VideoAnalyzer | None = None,
                    source_override: Path | None = None) -> dict[str, Any]:
    started = time.monotonic()
    # The legacy max_frames key may be present; native video analysis does not
    # extract or send image frames. Temporal resolution is controlled by fps.
    job = media.parse_job(payload)
    question = payload.get("question", "Describe what happens in this video.")
    if not isinstance(question, str) or not 1 <= len(question) <= 3000:
        raise media.InputError("question must be 1 to 3000 characters")
    with tempfile.TemporaryDirectory(prefix="runpod-native-video-") as temp:
        folder = Path(temp)
        source = folder / "source.video"
        if source_override is not None:
            if os.getenv("ALLOW_LOCAL_VIDEO_TESTS") != "1":
                raise media.InputError("Local source override is disabled")
            shutil.copyfile(source_override, source)
            size = source.stat().st_size
            with source.open("rb") as stream:
                sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
            if size > media.MAX_VIDEO_BYTES:
                raise media.InputError("Video exceeds 200 MiB limit")
            if job.expected_sha256 and sha256 != job.expected_sha256:
                raise media.InputError("Video hash mismatch")
        else:
            size, sha256 = media.download_private_video(job, source)
        return analyze_video_file(job, source, size, sha256,
                                  analyzer=analyzer, started=started,
                                  question=question)


def self_test(*, analyzer: VideoAnalyzer | None = None) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="runpod-native-self-test-") as temp:
        folder = Path(temp)
        source = folder / "synthetic.mp4"
        media._run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                   "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=8:duration=4",
                   "-c:v", "mpeg4", "-q:v", "6", "-an", "-y", str(source)], timeout=30)
        with source.open("rb") as stream:
            sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        job = media.VideoJob("native-video-self-test", "", 30.0, 32, False, None)
        result = analyze_video_file(job, source, source.stat().st_size, sha256,
                                    analyzer=analyzer)
        result["test_type"] = "native_video_gpu_inference"
        return result


def health() -> dict[str, Any]:
    ffmpeg = bool(shutil.which("ffmpeg"))
    ffprobe = bool(shutil.which("ffprobe"))
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "healthy" if ffmpeg and ffprobe else "unhealthy",
        "analysis_mode": "native_video",
        "model": os.getenv("VISION_MODEL", DEFAULT_MODEL),
        "ffmpeg_available": ffmpeg,
        "ffprobe_available": ffprobe,
        "maximum_video_duration_seconds": media.MAX_VIDEO_SECONDS_LIMIT,
        "maximum_video_bytes": media.MAX_VIDEO_BYTES,
    }


def handler(event: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = event.get("input") if isinstance(event, dict) else None
        if not isinstance(payload, dict):
            raise media.InputError("input must be an object")
        operation = payload.get("operation", "analyze")
        if operation == "health":
            return health()
        if operation == "self_test":
            return self_test()
        if operation != "analyze":
            raise media.InputError("Unknown operation")
        return analyze_request(payload)
    except media.InputError as exc:
        LOG.warning("Native video job rejected (%s)", type(exc).__name__)
        return {"schema_version": SCHEMA_VERSION, "status": "rejected",
                "error": {"code": "INVALID_INPUT", "message": "Invalid input"}}
    except Exception as exc:
        # Never log signed URLs, query strings, private paths or raw exception
        # text: a provider stack trace can contain URL bearer credentials.
        LOG.error("Native video job failed (%s)", type(exc).__name__)
        return {"schema_version": SCHEMA_VERSION, "status": "failed",
                "error": {"code": "PROCESSING_ERROR",
                          "message": "Native video inference did not complete"}}


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
