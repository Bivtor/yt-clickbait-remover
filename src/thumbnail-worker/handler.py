"""
Thumbnail extraction worker.

Recipe validated live through the Decodo residential proxy on 2026-06-23
(supersedes the §8/§9 plan — testing found a simpler path; see THUMBNAIL_PIPELINE.md):

  * The **tv_embedded** player client exposes DASH video-only formats up to 1080p
    WITH downloadable URLs and **NO PO token** (the web client is SABR-walled even
    with a token; tv_embedded is not). -> bgutil / JS runtime / token cache all dropped.
  * Stream URLs are **IP-locked** to the gate exit IP, so we use a **sticky session**
    (a -session-<id> suffix on the Decodo username) for the gate + the byte fetch.
  * Timestamp is free: we grab only the **first ~MB** of the chosen format via an
    HTTP Range request (through the sticky proxy) — that contains the init/moov + the
    opening keyframe — and decode that ONE keyframe. A few hundred KB regardless of
    video length. ffmpeg never touches the network (it can't proxy reliably); it only
    reads the local partial file.

Flow per SQS message ({"videoId": "..."}):
  1. GATE  — yt-dlp (tv_embedded) via sticky proxy: pick best avc/mp4 video-only <=1080p.
  2. FETCH — HTTP Range bytes=0-FETCH_BYTES of that format URL, through the sticky proxy.
  3. FRAME — ffmpeg decodes the first keyframe from the local partial file -> JPEG.
  4. STORE — JPEG -> S3; UpdateItem thumbUrl on Dynamo.

Downloaded byte count is logged per extraction = the proxy bill. Watch it in CloudWatch.
"""

import json
import logging
import os
import secrets
import subprocess
import time

import boto3
import requests
import yt_dlp

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("thumb-worker")
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

TABLE          = os.environ["TABLE_NAME"]
BUCKET         = os.environ["THUMB_BUCKET"]
CDN_DOMAIN     = os.environ.get("THUMB_CDN_DOMAIN", "").strip()       # CloudFront; falls back to S3 URL
REGION         = os.environ.get("AWS_REGION", "us-west-1")
PROXY          = os.environ.get("PROXY_URL", "").strip()
PLAYER_CLIENT  = os.environ.get("YTDLP_PLAYER_CLIENT", "tv_embedded").strip()
MAX_HEIGHT     = int(os.environ.get("MAX_HEIGHT", "720"))             # cap: 720p is plenty for a feed card
FETCH_BYTES    = int(os.environ.get("FETCH_BYTES", "1500000"))        # ~1.5MB: enough at 720p for init/moov + frames
FETCH_RETRY    = int(os.environ.get("FETCH_RETRY_BYTES", "4000000"))  # one bigger retry if decode fails
THUMB_FRAMES   = int(os.environ.get("THUMB_FRAMES", "300"))           # frames the thumbnail filter scans to pick a clean one
FRAME_VERSION  = os.environ.get("FRAME_VERSION", "2")                 # bumped: 360p->1080p heuristic
TARGET_WIDTH   = int(os.environ.get("TARGET_WIDTH", "1920"))          # no upscale; ~no-op for <=1080p
JPEG_QUALITY   = os.environ.get("JPEG_QUALITY", "3")                  # ffmpeg -q:v (2 best .. 31 worst)
MIN_JPEG_BYTES = int(os.environ.get("MIN_JPEG_BYTES", "2000"))        # below this = decode produced nothing usable
TTL_DAYS       = int(os.environ.get("TTL_DAYS", "180"))
FFMPEG         = "/usr/local/bin/ffmpeg"


# Errors that will NEVER succeed without auth / will never have a frame → mark the item
# so we don't burn retries (SQS) or re-enqueues (resolver self-heal) on them forever.
PERMANENT_MARKERS = (
    "confirm your age", "requires payment", "members-only", "members only",
    "private video", "video unavailable", "been removed", "removed by the uploader",
    "terminated", "who has blocked it", "not made this video available",
)


def is_permanent(msg: str) -> bool:
    m = msg.lower()
    return any(k in m for k in PERMANENT_MARKERS)


def mark_unavailable(video_id: str, reason: str):
    now = int(time.time())
    ddb.update_item(
        TableName=TABLE,
        Key={"videoId": {"S": video_id}},
        UpdateExpression="SET thumbStatus = :s, thumbReason = :r, #ttl = :ttl",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={
            ":s": {"S": "unavailable"},
            ":r": {"S": reason[:200]},
            ":ttl": {"N": str(now + TTL_DAYS * 86400)},
        },
    )


def proxy_with_session(base: str, session: str) -> str:
    """Inject a Decodo sticky -session-<id> suffix into the proxy username so the
    gate and the byte fetch share one exit IP (URLs are IP-locked)."""
    if not base or "://" not in base or "@" not in base:
        return base
    scheme, rest = base.split("://", 1)
    userinfo, host = rest.rsplit("@", 1)
    user, _, pw = userinfo.partition(":")
    if "-session-" not in user:
        user = f"{user}-session-{session}"
    return f"{scheme}://{user}:{pw}@{host}"


def pick_format(info: dict) -> dict:
    """Best video-only format <= MAX_HEIGHT, preferring avc/mp4 (most decodable)."""
    vids = [
        f for f in (info.get("formats") or [])
        if f.get("url")
        and f.get("vcodec") not in (None, "none")
        and f.get("acodec") in (None, "none")            # video-only (DASH)
        and 0 < (f.get("height") or 0) <= MAX_HEIGHT
    ]
    if not vids:
        # Fallback: any video format with a url (e.g. progressive) <= MAX_HEIGHT.
        vids = [
            f for f in (info.get("formats") or [])
            if f.get("url") and f.get("vcodec") not in (None, "none")
            and 0 < (f.get("height") or 0) <= MAX_HEIGHT
        ]
    if not vids:
        raise RuntimeError("no usable video format <= %dp with a url" % MAX_HEIGHT)

    def rank(f):
        avc = (f.get("vcodec") or "").startswith("avc")
        mp4 = f.get("ext") == "mp4"
        return ((f.get("height") or 0), int(avc) * 2 + int(mp4))

    return max(vids, key=rank)


def fetch_head(url: str, headers: dict, nbytes: int, proxy: str) -> bytes:
    """Range-GET the first nbytes through the proxy (requests CAN proxy https; ffmpeg can't)."""
    h = dict(headers or {})
    h["Range"] = f"bytes=0-{nbytes - 1}"
    proxies = {"http": proxy, "https": proxy} if proxy else None
    r = requests.get(url, headers=h, proxies=proxies, timeout=45)
    if r.status_code not in (200, 206):
        raise RuntimeError(f"range fetch HTTP {r.status_code}")
    return r.content


def decode_thumb(seg_path: str, out_path: str) -> bool:
    """Pick a representative non-black frame from the partial buffer via the
    thumbnail filter. NOTE: we judge success by the output file, NOT ffmpeg's exit
    code — the truncated tail of the partial mp4 reliably produces NAL errors +
    a non-zero rc even though a good frame was written."""
    if os.path.exists(out_path):
        os.remove(out_path)
    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", seg_path,
        "-vf", f"thumbnail={THUMB_FRAMES},scale='min({TARGET_WIDTH},iw)':-2",
        "-frames:v", "1", "-update", "1",
        "-q:v", str(JPEG_QUALITY), out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    ok = os.path.exists(out_path) and os.path.getsize(out_path) >= MIN_JPEG_BYTES
    if not ok:
        log.warning("ffmpeg thumbnail decode produced no usable frame (rc=%s): %s",
                    proc.returncode, "\n".join(proc.stderr.strip().splitlines()[-8:]))
    return ok


def process(video_id: str):
    t0 = time.time()
    session = secrets.token_hex(6)
    proxy = proxy_with_session(PROXY, session)
    url = f"https://www.youtube.com/watch?v={video_id}"
    log.info("[%s] === START === client=%s sticky=%s", video_id, PLAYER_CLIENT, session)

    # 1. GATE — metadata only, no media bytes.
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True,
        "extractor_args": {"youtube": {"player_client": PLAYER_CLIENT.split(",")}},
    }
    if PROXY:
        opts["proxy"] = proxy
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        # Permanent (age-gated / paid / members / removed) → mark + DON'T retry, so we
        # stop burning SQS retries + proxy bytes on something that can't ever succeed.
        if is_permanent(str(e)):
            mark_unavailable(video_id, str(e))
            log.info("[%s] PERMANENT (marked unavailable, no retry): %s", video_id, str(e)[:140])
            return
        raise  # transient (proxy 5xx, bot wall, premiere) → let SQS retry
    fmt = pick_format(info)
    log.info("[%s] GATE ok: title=%r dur=%ss -> format=%s %sx%s %s",
             video_id, info.get("title"), info.get("duration"),
             fmt.get("format_id"), fmt.get("width"), fmt.get("height"), fmt.get("vcodec"))

    # 2. FETCH — only the opening bytes (init/moov + first keyframe). This IS the bill.
    seg_path, out_path = "/tmp/seg.bin", "/tmp/frame.jpg"
    for p in (seg_path, out_path):
        if os.path.exists(p):
            os.remove(p)
    headers = fmt.get("http_headers")
    data = fetch_head(fmt["url"], headers, FETCH_BYTES, proxy)
    with open(seg_path, "wb") as fh:
        fh.write(data)
    log.info("[%s] FETCH %d bytes (%.2f MB) <-- proxy GB", video_id, len(data), len(data) / 1e6)

    # 3. FRAME — pick a clean representative frame; one bigger retry if needed.
    if not decode_thumb(seg_path, out_path):
        log.info("[%s] retry fetch at %d bytes", video_id, FETCH_RETRY)
        data = fetch_head(fmt["url"], headers, FETCH_RETRY, proxy)
        with open(seg_path, "wb") as fh:
            fh.write(data)
        log.info("[%s] FETCH(retry) %d bytes (%.2f MB)", video_id, len(data), len(data) / 1e6)
        if not decode_thumb(seg_path, out_path):
            raise RuntimeError("ffmpeg could not decode a frame from partial file")
    frame_bytes = os.path.getsize(out_path)
    log.info("[%s] FRAME ok: %d bytes", video_id, frame_bytes)

    # 4. STORE — S3 + Dynamo.
    key = f"{video_id}.jpg"
    with open(out_path, "rb") as fh:
        s3.put_object(Bucket=BUCKET, Key=key, Body=fh,
                      ContentType="image/jpeg",
                      CacheControl="public, max-age=15552000")
    thumb_url = (f"https://{CDN_DOMAIN}/{key}" if CDN_DOMAIN
                 else f"https://{BUCKET}.s3.{REGION}.amazonaws.com/{key}")
    now = int(time.time())
    ddb.update_item(
        TableName=TABLE,
        Key={"videoId": {"S": video_id}},
        UpdateExpression="SET thumbUrl = :u, thumbVersion = :v, thumbTs = :t, thumbHeight = :hh, #ttl = :ttl",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={
            ":u":   {"S": thumb_url},
            ":v":   {"S": FRAME_VERSION},
            ":t":   {"N": str(now * 1000)},
            ":hh":  {"N": str(fmt.get("height") or 0)},
            ":ttl": {"N": str(now + TTL_DAYS * 86400)},
        },
    )
    log.info("[%s] === DONE in %.1fs: s3://%s/%s (%dp, fetched %.2f MB) ===",
             video_id, time.time() - t0, BUCKET, key, fmt.get("height") or 0, len(data) / 1e6)


def handler(event, context):
    """SQS trigger. Per-message failures so only the failed ones retry."""
    failures = []
    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            video_id = json.loads(record["body"])["videoId"]
        except Exception as e:
            log.error("bad message %s: %s", message_id, e)
            continue  # malformed — don't retry forever
        try:
            process(video_id)
        except Exception as e:
            log.exception("[%s] FAILED: %s", video_id, e)
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}
