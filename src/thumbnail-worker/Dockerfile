# Thumbnail extraction worker — container image Lambda.
# Separate from the Node title worker: yt-dlp is Python and ffmpeg is a heavy
# native binary, so this carries its own toolchain without bloating the title path.
#
# Multi-arch: mwader/static-ffmpeg and the AWS base image both publish arm64 +
# amd64, so this builds for whatever the stack's Architectures is set to (arm64).
# Build/deploy with Docker running:  sam build && sam deploy

# ── Stage 1: grab a full static ffmpeg (includes https/openssl) ────────────────
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# ── Stage 2: Lambda Python runtime ─────────────────────────────────────────────
FROM public.ecr.aws/lambda/python:3.12

COPY --from=ffmpeg /ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

# yt-dlp is left unpinned on purpose — YouTube walls break and get re-fixed
# upstream within days, so rebuilding this image picks up the latest extractor.
# (If you want reproducible deploys, pin a version here and bump it on a cadence.)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY handler.py ./
CMD ["handler.handler"]
