from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src import worker

HOST = "exampleproject.supabase.co"
URL = f"https://{HOST}/storage/v1/object/sign/katie-attachments/chats/abc/example.source?token=TEST_TOKEN"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("ALLOWED_STORAGE_HOST", HOST)
    monkeypatch.setenv("ALLOW_LOCAL_VIDEO_TESTS", "1")


def input_data(**overrides):
    return {
        "attachment_id": "abc_123",
        "source_url": URL,
        "max_frames": 8,
        "max_duration_seconds": 20,
        **overrides,
    }


class FakeAnalyzer:
    model_id = "fake/test-double"

    def describe(self, samples):
        return f"Observed {len(samples)} video frames in temporal order."

    def summarize(self, segments):
        return f"Sampled analysis across {len(segments)} video segment(s)."


@pytest.fixture
def synthetic_video(tmp_path):
    video = tmp_path / "test.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=8:duration=6",
        "-c:v", "mpeg4", "-q:v", "4", "-an", "-y", str(video),
    ], check=True, timeout=30)
    return video


def test_no_content_attestation_is_required():
    """The video job accepts requests without any media-content policy flag."""
    assert worker.parse_job(input_data()).attachment_id == "abc_123"
    assert worker.parse_job(input_data(content_policy_confirmed=False)).attachment_id == "abc_123"
    assert worker.parse_job(input_data(content_policy_confirmed=True)).attachment_id == "abc_123"


@pytest.mark.parametrize("url", [
    "http://exampleproject.supabase.co/storage/v1/object/sign/katie-attachments/x?token=abc",
    "https://attacker.example/storage/v1/object/sign/katie-attachments/x?token=abc",
    "https://exampleproject.supabase.co@attacker.example/storage/v1/object/sign/katie-attachments/x?token=abc",
    "https://exampleproject.supabase.co/storage/v1/object/public/katie-attachments/x?token=abc",
    "https://exampleproject.supabase.co/storage/v1/object/sign/katie-attachments/x",
    "https://exampleproject.supabase.co:444/storage/v1/object/sign/katie-attachments/x?token=abc",
    "https://exampleproject.supabase.co/storage/v1/object/sign/other-bucket/x?token=abc",
    "file:///etc/passwd",
])
def test_rejects_untrusted_video_urls(url):
    with pytest.raises(worker.InputError):
        worker.parse_job(input_data(source_url=url))


def test_limits_and_types():
    for bad in (0, 49, 5.5, True):
        with pytest.raises(worker.InputError):
            worker.parse_job(input_data(max_frames=bad))
    for bad in (0, 601, float("inf"), True):
        with pytest.raises(worker.InputError):
            worker.parse_job(input_data(max_duration_seconds=bad))
    with pytest.raises(worker.InputError):
        worker.parse_job(input_data(transcribe_audio="yes"))
    with pytest.raises(worker.InputError):
        worker.parse_job(input_data(expected_sha256="invalid"))


def test_valid_input():
    job = worker.parse_job(input_data(expected_sha256="0" * 64, transcribe_audio=True))
    assert job.max_frames == 8
    assert job.expected_sha256 == "0" * 64
    assert job.transcribe_audio is True


def test_ffmpeg_and_json_schema_on_safe_synthetic_video(synthetic_video):
    result = worker.process_video(input_data(), analyzer=FakeAnalyzer(), source_override=synthetic_video)
    assert result["schema_version"] == "1.0"
    assert result["status"] == "completed"
    assert result["model"] == "fake/test-double"
    assert result["coverage"] == "sampled"
    assert 5.5 <= result["duration_seconds"] <= 6.5
    assert 1 <= result["frames_sampled"] <= 8
    assert result["dimensions"] == {"width": 320, "height": 240}
    assert result["frame_timestamps_seconds"] == sorted(result["frame_timestamps_seconds"])
    assert len(result["segments"]) >= 1
    assert all("description" in segment and "sample_timestamps_seconds" in segment for segment in result["segments"])
    assert "transcript" in result["audio"]
    assert result["audio"]["present"] is False
    assert result["audio"]["status"] == "not_requested"
    assert result["sha256"] == hashlib.sha256(synthetic_video.read_bytes()).hexdigest()
    assert URL not in json.dumps(result)


def test_video_pipeline_accepts_legacy_false_attestation(synthetic_video):
    """An obsolete `content_policy_confirmed` value cannot veto an otherwise valid job."""
    result = worker.process_video(
        input_data(content_policy_confirmed=False),
        analyzer=FakeAnalyzer(), source_override=synthetic_video,
    )
    assert result["status"] == "completed"
    assert result["frames_sampled"] > 0


def test_over_limit_video_duration(synthetic_video):
    with pytest.raises(worker.InputError, match="duration exceeds"):
        worker.process_video(input_data(max_duration_seconds=2), analyzer=FakeAnalyzer(), source_override=synthetic_video)


def test_sha256_mismatch(synthetic_video):
    with pytest.raises(worker.InputError, match="hash"):
        worker.process_video(input_data(expected_sha256="0" * 64), analyzer=FakeAnalyzer(), source_override=synthetic_video)


def test_local_override_disabled_for_production(synthetic_video, monkeypatch):
    monkeypatch.delenv("ALLOW_LOCAL_VIDEO_TESTS")
    with pytest.raises(worker.InputError, match="disabled"):
        worker.process_video(input_data(), analyzer=FakeAnalyzer(), source_override=synthetic_video)


def test_handler_rejects_bad_jobs_without_model_init():
    assert worker.handler({"input": {}})["status"] == "rejected"


def test_redirect_is_rejected_without_following_it(tmp_path):
    response = MagicMock()
    response.is_redirect = True
    response.__enter__.return_value = response
    response.__exit__.return_value = None
    with patch.object(worker.requests, "get", return_value=response) as getter:
        with pytest.raises(worker.InputError, match="redirect"):
            worker.download_private_video(worker.parse_job(input_data()), tmp_path / "video.mp4")
        assert getter.call_args.kwargs["allow_redirects"] is False


def test_size_check_blocks_large_download(tmp_path):
    response = MagicMock()
    response.is_redirect = False
    response.headers = {"content-length": str(worker.MAX_VIDEO_BYTES + 1)}
    response.__enter__.return_value = response
    response.__exit__.return_value = None
    with patch.object(worker.requests, "get", return_value=response):
        with pytest.raises(worker.InputError, match="200 MiB"):
            worker.download_private_video(worker.parse_job(input_data()), tmp_path / "video.mp4")


def test_no_signed_token_in_network_error(tmp_path):
    import requests
    with patch.object(worker.requests, "get", side_effect=requests.RequestException(URL)):
        with pytest.raises(worker.ProcessingError) as failure:
            worker.download_private_video(worker.parse_job(input_data()), tmp_path / "video.mp4")
        assert "TEST_TOKEN" not in str(failure.value)


def test_no_age_identification_from_frames(synthetic_video):
    result = worker.process_video(input_data(), analyzer=FakeAnalyzer(), source_override=synthetic_video)
    assert any("age" in statement for statement in result["limitations"])

@pytest.mark.parametrize(('extension', 'muxer'), [
    ('mp4', 'mp4'),
    ('mov', 'mov'),
    ('mkv', 'matroska'),
    ('avi', 'avi'),
    ('ts', 'mpegts'),
])
def test_worker_decodes_diverse_ffmpeg_video_containers(tmp_path, extension, muxer):
    """No extension or provider-specific format allowlist rejects decodable media."""
    video = tmp_path / f'encoded.{extension}'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=5:duration=2',
        '-c:v', 'mpeg4', '-q:v', '6', '-an', '-f', muxer, '-y', str(video),
    ], check=True, timeout=30)
    result = worker.process_video(input_data(max_duration_seconds=10), analyzer=FakeAnalyzer(), source_override=video)
    assert result['status'] == 'completed'
    assert result['frames_sampled'] > 0
    assert result['duration_seconds'] > 1


def test_worker_self_test_requires_no_storage_or_google(monkeypatch):
    monkeypatch.delenv('ALLOWED_STORAGE_HOST', raising=False)
    result = worker.self_test(analyzer=FakeAnalyzer())
    assert result['status'] == 'completed'
    assert result['attachment_id'] == 'synthetic-self-test'
    assert result['model'] == 'fake/test-double'
    assert result['test_type'] == 'synthetic_video_gpu_inference'
    assert result['frames_sampled'] > 0


def test_health_endpoint_independent_of_gpu_or_storage(monkeypatch):
    monkeypatch.delenv('ALLOWED_STORAGE_HOST', raising=False)
    response = worker.handler({'input': {'operation': 'health'}})
    assert response['status'] == 'healthy'
    assert response['ffmpeg_available'] is True
    assert response['ffprobe_available'] is True
    assert response['max_video_bytes'] == worker.MAX_VIDEO_BYTES


def test_worker_invalid_operation_is_rejected():
    assert worker.handler({'input': {'operation': 'wipe_server'}})['status'] == 'rejected'


def test_worker_does_not_reject_when_legacy_attestation_false(monkeypatch):
    """A former client-supplied content flag is ignored, not used for filtering."""
    monkeypatch.setattr(worker, "get_analyzer", lambda: FakeAnalyzer())
    # A missing file will fail at download, but should never be a policy rejection.
    with patch.object(worker, "download_private_video", side_effect=worker.ProcessingError("Test: source unavailable")):
        response = worker.handler({"input": input_data(content_policy_confirmed=False)})
    assert response["status"] == "failed"
    assert response["error"]["code"] == "PROCESSING_ERROR"


def test_webm_vp8_supported(tmp_path):
    webm = tmp_path / 'test.webm'
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=5:duration=2',
        '-c:v', 'libvpx', '-b:v', '200k', '-an', '-y', str(webm),
    ], check=True, timeout=30)
    result = worker.process_video(input_data(max_duration_seconds=10), analyzer=FakeAnalyzer(), source_override=webm)
    assert result['status'] == 'completed'
    assert result['frames_sampled'] > 0
