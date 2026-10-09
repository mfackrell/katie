# Build with GitHub repository ROOT as the Docker build context.
# Use Dockerfile path: services/runpod-video-worker/Dockerfile
# RunPod's GPU/PyTorch base includes CUDA + torch compatible with its Python runtime.
# Pin the base image digest before production deployment for reproducible builds.
FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2204

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY services/runpod-video-worker/requirements.txt ./requirements.txt
# Torch comes with the base image; prevent pip from selecting an incompatible CUDA build.
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY services/runpod-video-worker/src ./src
ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface \
    LOG_LEVEL=INFO
CMD ["python", "-m", "src.worker"]
