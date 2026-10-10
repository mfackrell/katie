"""Native-video contract tests, no GPU required.

These run independently of the existing still-image worker tests and ensure
one original video is passed into one video-aware multimodal analyzer call.
"""
from pathlib import Path
import subprocess

import pytest

from src import native_video_worker as native


HOST = "exampleproject.supabase.co"
URL = f"https://{HOST}/storage/v1/object/sign/katie-attachments/chats/test/abc.source?token=LOCAL_TEST_TOKEN"


class FakeVideoModel:
    model_id = "fake/native-video-analyzer"

    def __init__(self):
        self.calls = []

    def analyze_video(self, video_path: Path, duration_seconds: float, question: str) -> str:
        assert video_path.is_file()
        assert video_path.suffix == ".video" or video_path.suffix == ".mp4"
        assert video_path.stat().st_size > 0
        self.calls.append((video_path, duration_seconds, question))
        return "At the start there is a test pattern; the pattern persists across the clip."


@pytest.fixture
def synthetic_video(tmp_path):
    path = tmp_path / "native-input.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
         "-f", "lavfi", "-i", "testsrc2=size=192x128:rate=8:duration=4",
         "-c:v", "mpeg4", "-q:v", "5", "-an", "-y", str(path)],
        check=True, timeout=30
    )
    return path


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ALLOWED_STORAGE_HOST", HOST)
    monkeypatch.setenv("ALLOW_LOCAL_VIDEO_TESTS", "1")


def test_native_video_full_file_contract(synthetic_video):
    model = FakeVideoModel()
    result = native.analyze_request({
        "attachment_id": "native-test-1",
        "source_url": URL,
        "max_duration_seconds": 30,
        "question": "What changed during the clip?"
    }, analyzer=model, source_override=synthetic_video)
    assert result["status"] == "completed"
    assert result["analysis_mode"] == "native_video"
    assert result["coverage"] == "video_with_temporal_sampling"
    assert result["model"] == model.model_id
    assert result["duration_seconds"] >= 3.9
    assert result["summary"].startswith("At the start")
    assert len(model.calls) == 1
    assert model.calls[0][2] == "What changed during the clip?"
    assert "frames_sampled" not in result
    assert "frame_timestamps_seconds" not in result
    assert "segments" not in result
    assert "Video processor" not in result["summary"]


def test_native_video_self_test_runs_analyzer_once():
    model = FakeVideoModel()
    result = native.self_test(analyzer=model)
    assert result["status"] == "completed"
    assert result["test_type"] == "native_video_gpu_inference"
    assert len(model.calls) == 1


def test_handler_health_without_gpu():
    result = native.handler({"input": {"operation": "health"}})
    assert result["analysis_mode"] == "native_video"
    assert result["model"] == native.DEFAULT_MODEL
    assert result["status"] == "healthy"


def test_native_video_security_never_accepts_arbitrary_source(monkeypatch):
    model = FakeVideoModel()
    monkeypatch.setattr(native, "get_analyzer", lambda: model)
    result = native.handler({"input": {
        "attachment_id": "abc",
        "source_url": "https://evil.example.com/video.mp4?token=BAD"
    }})
    assert result["status"] == "rejected"
    assert not model.calls
    assert "evil" not in str(result)


def test_native_video_invalid_question_rejected(synthetic_video):
    with pytest.raises(native.media.InputError, match="question"):
        native.analyze_request({
            "attachment_id": "abc", "source_url": URL, "question": ""
        }, analyzer=FakeVideoModel(), source_override=synthetic_video)


def test_fps_is_bounded_over_full_video_duration():
    assert native.recommended_video_fps(5) == 2
    assert native.recommended_video_fps(600) <= 0.35
    assert native.recommended_video_fps(600) >= 0.15


def test_real_qwen_inference_payload_uses_video_not_image_list():
    # Guard architecture against a regression to the prior JPEG-based fallback.
    source = Path(native.__file__).read_text()
    assert '"type": "video"' in source
    assert 'return_video_metadata=True' in source
    assert "videos=list(videos)" in source
    assert "sample_frames(" not in source
    assert "model.describe(" not in source
    assert "frame_timestamps_seconds" not in source
