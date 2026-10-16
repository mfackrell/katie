"""RunPod worker deployment gate: synthetic-media checks only; no GPU claims."""
import concurrent.futures
import hashlib
import json
import subprocess
from unittest.mock import MagicMock, patch

import pytest
import requests
from PIL import Image

from src import worker

HOST = 'testproject.supabase.co'
SECRET = 'CONFIDENTIAL_FAKE_SIGNED_URL_TOKEN'
URL = f'https://{HOST}/storage/v1/object/sign/katie-attachments/chats/abc/test.source?token={SECRET}'


class FakeModel:
    model_id = 'test/mock-no-gpu'
    def describe(self, samples):
        return f'Observed {len(samples)} synthetic frames'
    def summarize(self, segments):
        return f'Observed {len(segments)} synthetic segments'


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv('ALLOWED_STORAGE_HOST', HOST)
    monkeypatch.setenv('ALLOW_LOCAL_VIDEO_TESTS', '1')


def job(**kw):
    return {'attachment_id': 'qa-video', 'source_url': URL,
            'max_frames': 8, 'max_duration_seconds': 20, **kw}


def make_media(path, *, duration=2, codec='mpeg4', audio=False):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
           '-f', 'lavfi', '-i', f'testsrc2=size=128x96:rate=6:duration={duration}']
    if audio:
        cmd.extend(['-f', 'lavfi', '-i', f'sine=frequency=440:duration={duration}'])
    cmd.extend(['-c:v', codec])
    if codec == 'mpeg4':
        cmd.extend(['-q:v', '5'])
    if codec == 'libx264':
        cmd.extend(['-preset', 'ultrafast', '-crf', '28'])
    if codec == 'libx265':
        cmd.extend(['-preset', 'ultrafast', '-x265-params', 'log-level=error'])
    if codec == 'libvpx-vp9':
        cmd.extend(['-b:v', '100k'])
    cmd.extend(['-c:a', 'pcm_s16le'] if audio else ['-an'])
    subprocess.run([*cmd, '-y', str(path)], check=True, timeout=30)
    return path


@pytest.mark.parametrize('event', [None, 1, 'x', [], {}, {'input': 'x'}])
def test_malformed_job_is_rejected(event):
    assert worker.handler(event)['status'] == 'rejected'


def test_corrupt_media_cannot_be_analyzed(tmp_path):
    video = tmp_path / 'bad.mp4'
    video.write_bytes(b'not a movie' * 64)
    with pytest.raises((worker.InputError, worker.ProcessingError)):
        worker.process_video(job(), analyzer=FakeModel(), source_override=video)


def test_audio_present_and_transcript_wiring(tmp_path):
    video = make_media(tmp_path / 'audio.mkv', audio=True)
    dur, has_audio, width, height = worker.probe_video(video)
    assert has_audio and dur > 1 and (width, height) == (128, 96)
    pcm = tmp_path / 'audio.wav'
    worker.extract_audio(video, pcm)
    assert pcm.stat().st_size > 2000
    samples = [{'start_seconds': 0.2, 'end_seconds': 1.7, 'text': 'Test speech'}]
    with patch.object(worker, 'transcribe_audio', return_value=samples):
        result = worker.process_video(job(transcribe_audio=True),
                                      analyzer=FakeModel(), source_override=video)
    assert result['status'] == 'completed'
    assert result['audio'] == {'present': True, 'status': 'completed', 'transcript': samples}


@pytest.mark.parametrize('code', [401, 403, 429, 500])
def test_signed_url_errors_redacted(tmp_path, code):
    response = MagicMock(is_redirect=False)
    response.headers = {}
    response.raise_for_status.side_effect = requests.HTTPError(f'{code}: {URL}')
    response.__enter__.return_value = response
    with patch.object(worker.requests, 'get', return_value=response):
        with pytest.raises(worker.ProcessingError) as ex:
            worker.download_private_video(worker.parse_job(job()), tmp_path / 'output')
    assert SECRET not in str(ex.value)


def test_streamed_private_download_to_analysis(tmp_path, monkeypatch):
    video = make_media(tmp_path / 'synthetic.mp4')
    binary = video.read_bytes()
    response = MagicMock(is_redirect=False)
    response.headers = {'content-length': str(len(binary))}
    response.iter_content.return_value = [binary[:200], binary[200:]]
    response.__enter__.return_value = response
    monkeypatch.setattr(worker, 'get_analyzer', lambda: FakeModel())
    monkeypatch.delenv('ALLOW_LOCAL_VIDEO_TESTS')
    with patch.object(worker.requests, 'get', return_value=response):
        result = worker.handler({'input': job(expected_sha256=hashlib.sha256(binary).hexdigest())})
    assert result['status'] == 'completed' and result['source_bytes'] == len(binary)
    assert SECRET not in json.dumps(result)


def test_error_logs_do_not_expose_video_token(monkeypatch, caplog):
    monkeypatch.setattr(worker, 'get_analyzer', lambda: FakeModel())
    with patch.object(worker, 'download_private_video',
                      side_effect=RuntimeError(f'private signed URL token={SECRET}')):
        result = worker.handler({'input': job()})
    assert result['status'] == 'failed'
    assert SECRET not in caplog.text and SECRET not in json.dumps(result)


def test_health_reports_missing_ffmpeg(monkeypatch):
    monkeypatch.setattr(worker.shutil, 'which', lambda name: None if name == 'ffmpeg' else '/usr/bin/ffprobe')
    result = worker.handler({'input': {'operation': 'health'}})
    assert result['status'] == 'unhealthy'


def test_parallel_jobs_are_isolated(tmp_path):
    video = make_media(tmp_path / 'synthetic.mp4')
    def run(i):
        return worker.process_video(job(attachment_id=f'parallel-{i}'), analyzer=FakeModel(), source_override=video)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(run, range(8)))
    assert len(results) == 8
    assert all(r['status'] == 'completed' for r in results)
    assert len({r['attachment_id'] for r in results}) == 8


@pytest.mark.parametrize('codec,container', [
    ('libx264', 'mp4'), ('libx265', 'mkv'), ('libvpx-vp9', 'webm'),
])
def test_modern_video_codecs(tmp_path, codec, container):
    available = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'],
                               capture_output=True, text=True, check=True)
    if codec not in available.stdout:
        pytest.skip(f'{codec} encoder not installed')
    video = make_media(tmp_path / f'video.{container}', codec=codec)
    result = worker.process_video(job(), analyzer=FakeModel(), source_override=video)
    assert result['status'] == 'completed' and result['frames_sampled'] > 0


def test_scene_change_preserves_chronology(tmp_path):
    video = tmp_path / 'colors.mkv'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'color=c=red:size=96x64:rate=4:duration=2',
        '-f', 'lavfi', '-i', 'color=c=blue:size=96x64:rate=4:duration=2',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]',
        '-map', '[out]', '-c:v', 'mpeg4', '-y', str(video)], check=True, timeout=30)
    class ColorModel(FakeModel):
        def describe(self, samples):
            out = []
            for sample in samples:
                with Image.open(sample.path) as image:
                    red, _, blue = image.convert('RGB').getpixel((48, 32))
                out.append('red' if red > blue else 'blue')
            return ','.join(out)
    result = worker.process_video(job(), analyzer=ColorModel(), source_override=video)
    observed = ','.join(part['description'] for part in result['segments']).split(',')
    assert observed[0] == 'red' and observed[-1] == 'blue'
    assert observed == sorted(observed, key=lambda color: color == 'blue')
