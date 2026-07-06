"""
Thumbnail extraction worker.

Recipe validated live through the Decodo residential proxy on 2026-06-23
(supersedes the §8/§9 plan — testing found a simpler path; see THUMBNAIL_PIPELINE.md):

  * The **tv_embedded** player client exposes DASH video-only formats up to 1080p
    WITH downloadable URLs and **NO PO token** (the web client is SABR-walled even
    with a token; tv_embedded is not). -> bgutil / JS runtime / token cache all dropped.
  * Stream URLs need a **residential** exit IP (datacenter is 403'd, §16); we use a sticky
    -session-<id> on the Decodo username for the gate + byte fetch. NOTE (§16): the URL is
    NOT locked to the EXACT gate IP — any residential IP works — so sticky is belt-and-suspenders,
    not strictly required.
  * Timestamp is free: we grab only the **first ~0.2MB** (FETCH_BYTES, §16) of the chosen
    format via an HTTP Range request (through the sticky proxy) — that contains the init/moov +
    the opening keyframes. A few hundred KB regardless of video length. ffmpeg never touches the
    network (it can't proxy reliably); it only reads the local partial file.
  * Frame pick = **entropy-gated blur vote** (`pick_frame`, FRAME_VERSION 3): one ffmpeg pass
    scores every decoded frame (blurdetect + entropy + signalstats) and picks the sharpest
    high-information frame, steering off flat/black/single-colour/intro frames. Falls back
    gracefully (tier B/C) when the whole 0.2MB buffer is intro animation ('need more data').
  * **Per-extraction proxy spend is hard-capped at FETCH_BYTES** — there is NO big re-fetch on a
    bad frame (§16 decision). A creator's black/info intro frame is an *accurate* thumbnail, so
    we keep it. If the fetch decodes nothing at all, we just raise → normal SQS retry (still only
    FETCH_BYTES) → DLQ.

Flow per SQS message ({"videoId": "..."}):
  1. GATE  — yt-dlp (tv_embedded) via sticky proxy: pick best avc/mp4 video-only <=1080p.
  2. FETCH — HTTP Range bytes=0-FETCH_BYTES of that format URL, through the sticky proxy.
  3. FRAME — ffmpeg decodes the first keyframe from the local partial file -> JPEG.
  4. STORE — JPEG -> S3; UpdateItem thumbUrl on Dynamo.

Downloaded byte count is logged per extraction = the proxy bill. Watch it in CloudWatch.
"""

import glob
import json
import logging
import os
import re
import secrets
import shutil
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


def _load_proxy() -> str:
    """Proxy URL (residential creds) comes from SSM SecureString at runtime — only the
    parameter NAME is in env, so the credentials never sit in CloudFormation or the
    Lambda console. Fetched once per cold start (this worker is async; latency is free).
    PROXY_URL env is kept as a local-testing fallback only."""
    param = os.environ.get("PROXY_PARAM", "").strip()
    if param:
        ssm = boto3.client("ssm")
        return ssm.get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"].strip()
    return os.environ.get("PROXY_URL", "").strip()


PROXY          = _load_proxy()
PLAYER_CLIENT  = os.environ.get("YTDLP_PLAYER_CLIENT", "tv_embedded").strip()
MAX_HEIGHT     = int(os.environ.get("MAX_HEIGHT", "720"))             # cap: 720p is plenty for a feed card
FETCH_BYTES    = int(os.environ.get("FETCH_BYTES", "200000"))         # ~0.2MB: §16 floor. HARD CAP on proxy bytes/extraction — no big re-fetch.
FRAME_VERSION  = os.environ.get("FRAME_VERSION", "3")                 # v3: entropy-gated blur vote (was thumbnail filter)
TARGET_WIDTH   = int(os.environ.get("TARGET_WIDTH", "1920"))          # no upscale; ~no-op for <=1080p
JPEG_QUALITY   = os.environ.get("JPEG_QUALITY", "3")                  # ffmpeg -q:v (2 best .. 31 worst)
MIN_JPEG_BYTES = int(os.environ.get("MIN_JPEG_BYTES", "2000"))        # below this = decode produced nothing usable
DARK_YAVG      = float(os.environ.get("DARK_YAVG", "16"))             # mean luma below this = near-black (excluded from tier-A vote, §16)
BRIGHT_YAVG    = float(os.environ.get("BRIGHT_YAVG", "250"))          # mean luma above this = blown white (excluded from tier-A vote)
ENTROPY_MIN    = float(os.environ.get("THUMB_ENTROPY_MIN", "5.0"))    # min image entropy (bits) for "real content" — steers off flat/solid/intro frames (§16)
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
    try:
        ddb.update_item(
            TableName=TABLE,
            Key={"videoId": {"S": video_id}},
            UpdateExpression="SET thumbStatus = :s, thumbReason = :r",
            # Don't CREATE an orphan row (thumbStatus-only) if the resolver's pending
            # write was lost — only annotate items that actually exist.
            ConditionExpression="attribute_exists(videoId)",
            ExpressionAttributeValues={
                ":s": {"S": "unavailable"},
                ":r": {"S": reason[:200]},
            },
        )
    except ddb.exceptions.ConditionalCheckFailedException:
        log.warning("[%s] mark_unavailable skipped: item does not exist", video_id)


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
    """Range-GET the first nbytes through the proxy (requests CAN proxy https; ffmpeg can't).

    Streamed + truncated client-side so nbytes is a REAL hard cap on proxy bytes: a server
    that ignores the Range header (HTTP 200 = full body) would otherwise pull the whole
    video through the residential proxy — the exact cost blowout FETCH_BYTES exists to
    prevent — and r.content would buffer it all before we could notice."""
    h = dict(headers or {})
    h["Range"] = f"bytes=0-{nbytes - 1}"
    proxies = {"http": proxy, "https": proxy} if proxy else None
    r = requests.get(url, headers=h, proxies=proxies, timeout=45, stream=True)
    try:
        if r.status_code not in (200, 206):
            raise RuntimeError(f"range fetch HTTP {r.status_code}")
        if r.status_code == 200:
            log.warning("range header ignored (HTTP 200) — truncating stream at %d bytes", nbytes)
        buf = bytearray()
        for chunk in r.iter_content(chunk_size=65536):
            buf.extend(chunk)
            if len(buf) >= nbytes:
                break
        return bytes(buf[:nbytes])
    finally:
        r.close()


_FRAMES_DIR = "/tmp/dc_frames"


def _parse_frame_metrics(meta_path: str):
    """Parse ffmpeg metadata=print output → per-frame {blur, ent, y} in decode order.
    Keys: lavfi.blur (blurdetect, lower=sharper), lavfi.entropy.entropy.normal.Y (image
    information, higher=more detail — NOTE the doubled 'entropy'), lavfi.signalstats.YAVG."""
    frames, cur = [], {}
    if not os.path.exists(meta_path):
        return frames
    with open(meta_path) as fh:
        for ln in fh:
            if ln.startswith("frame:"):
                if cur:
                    frames.append(cur)
                cur = {}
            m = re.search(r"lavfi\.blur=([0-9.]+)", ln)
            if m: cur["blur"] = float(m.group(1))
            m = re.search(r"entropy\.entropy\.normal\.Y=([0-9.]+)", ln)
            if m: cur["ent"] = float(m.group(1))
            m = re.search(r"signalstats\.YAVG=([0-9.]+)", ln)
            if m: cur["y"] = float(m.group(1))
    if cur:
        frames.append(cur)
    return frames


def _best_index(frames):
    """Entropy-gated blur vote (§16). Tier A: the sharpest (lowest blur) frame that is
    neither near-black nor blown-out AND is high-entropy (real visual content) — this
    steers away from flat/black/single-colour/intro frames. Falls back to sharpest
    not-dark (B), then sharpest of anything (C) when the buffer holds only intro frames
    ('need more data' videos). Returns (index, tier)."""
    n = len(frames)
    poolA = [i for i in range(n)
             if DARK_YAVG <= frames[i].get("y", 0) <= BRIGHT_YAVG
             and frames[i].get("ent", 0) >= ENTROPY_MIN]
    poolB = [i for i in range(n) if frames[i].get("y", 0) >= DARK_YAVG]
    if poolA:   pool, tier = poolA, "A"
    elif poolB: pool, tier = poolB, "B"
    else:       pool, tier = list(range(n)), "C"
    best = min(pool, key=lambda i: frames[i].get("blur", 1e9))
    return best, tier


def pick_frame(seg_path: str, out_path: str):
    """Decode every frame in the partial buffer, score each (blurdetect + entropy +
    signalstats in ONE pass, no extra proxy bytes), and copy out the voted best frame.
    Returns (ok, luma, tier, nframes). NOTE: success is judged by the output file, not
    ffmpeg's exit code — the truncated tail of the partial mp4 reliably yields NAL errors
    + a non-zero rc even though the good frames decoded fine."""
    shutil.rmtree(_FRAMES_DIR, ignore_errors=True)
    os.makedirs(_FRAMES_DIR, exist_ok=True)
    meta = os.path.join(_FRAMES_DIR, "m.txt")
    # blurdetect+entropy+signalstats compute metrics on the full-res frame; scale is for the
    # written JPEG only; metadata=print emits per-frame metrics aligned with the f_%05d.jpg.
    cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", seg_path,
        "-vf", f"blurdetect,entropy,signalstats,scale='min({TARGET_WIDTH},iw)':-2,"
               f"metadata=print:file={meta}",
        "-q:v", str(JPEG_QUALITY), os.path.join(_FRAMES_DIR, "f_%05d.jpg"),
    ]
    # < the 120s Lambda timeout, so a hung ffmpeg hits THIS guard (python error path +
    # frames-dir cleanup) instead of a hard Lambda kill.
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)

    frames = _parse_frame_metrics(meta)
    jpgs = sorted(glob.glob(os.path.join(_FRAMES_DIR, "f_*.jpg")))
    n = min(len(frames), len(jpgs))
    if n == 0:
        log.warning("pick_frame: no frames decoded (rc=%s): %s", proc.returncode,
                    "\n".join(proc.stderr.strip().splitlines()[-6:]))
        shutil.rmtree(_FRAMES_DIR, ignore_errors=True)
        return False, None, None, 0
    frames, jpgs = frames[:n], jpgs[:n]

    idx, tier = _best_index(frames)
    luma = frames[idx].get("y")
    if os.path.exists(out_path):
        os.remove(out_path)
    shutil.copy(jpgs[idx], out_path)
    ok = os.path.getsize(out_path) >= MIN_JPEG_BYTES
    shutil.rmtree(_FRAMES_DIR, ignore_errors=True)
    return ok, luma, tier, n


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

    # 3. FRAME — entropy-gated blur vote over the fetched bytes (§16): pick the sharpest
    # high-information frame, steering off flat/black/intro frames. No big re-fetch: if the
    # fetch decodes nothing usable we raise → SQS retry re-attempts at FETCH_BYTES, never more.
    # tier=A means a real content frame was found; tier=B/C means the whole buffer was intro
    # ('need more data') and we kept the best available — logged for observability.
    ok, luma, tier, nframes = pick_frame(seg_path, out_path)
    if not ok:
        raise RuntimeError("could not extract a usable frame from the partial fetch")
    frame_bytes = os.path.getsize(out_path)
    dark = luma is not None and luma < DARK_YAVG
    log.info("[%s] FRAME ok: %d bytes (tier=%s YAVG=%s%s, %d frames scanned)",
             video_id, frame_bytes, tier,
             f"{luma:.0f}" if luma is not None else "?",
             " near-black" if dark else "", nframes)

    # 4. STORE — S3 + Dynamo. The FRAME_VERSION lives in the object KEY: re-extraction
    # under a new version must produce a NEW URL, because the old one is cached for up to
    # 180d by CloudFront AND browsers (max-age below) — rewriting the same key would make
    # a version bump invisible for months. (Query strings won't do it: the CachingOptimized
    # policy excludes them from the cache key.) Old-version objects are left to rot;
    # storage is trivial (§6).
    key = f"{video_id}.v{FRAME_VERSION}.jpg"
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
        # Reset thumbAttempts on success so a healthy item stays eligible for a future
        # FRAME_VERSION re-extract (only persistent FAILURES should accumulate to the cap).
        UpdateExpression="SET thumbUrl = :u, thumbVersion = :v, thumbTs = :t, thumbHeight = :hh, thumbAttempts = :zero",
        ExpressionAttributeValues={
            ":u":    {"S": thumb_url},
            ":v":    {"S": FRAME_VERSION},
            ":t":    {"N": str(now * 1000)},
            ":hh":   {"N": str(fmt.get("height") or 0)},
            ":zero": {"N": "0"},
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
