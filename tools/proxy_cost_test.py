#!/usr/bin/env python3
"""
proxy_cost_test.py — local probe to cut the Decodo residential GB bill (THUMBNAIL_PIPELINE §16).

The thumbnail worker's dominant cost is the ~1.5MB Range GET of the DASH segment THROUGH
the residential proxy (handler.py `fetch_head`). The gate (yt-dlp metadata) is tiny. §7
forced that fetch onto residential because stream URLs are IP-locked (`ip=`) to the gate's
exit IP. This script re-tests that assumption and finds the cheapest fetch path, WITHOUT
burning much residential GB itself.

For each sampled videoId it measures these routes:

  R-same     gate=residential sticky, fetch=SAME residential session     (baseline, known good)
  direct     gate=residential sticky, fetch=DIRECT (no proxy)            (0 residential fetch bytes)
  R->DC      gate=residential sticky, fetch=datacenter proxy             (0 residential fetch bytes)
  DC-full    gate=datacenter sticky,  fetch=SAME datacenter session      (0 residential at all)

…and a FETCH_BYTES floor sweep done by truncating ONE residential fetch locally (so the
sweep costs a single 1.5MB residential pull per video, not one per size).

Each candidate frame is decoded with ffmpeg's `thumbnail` filter (mirrors handler.py) and
checked for black/flat via `signalstats` YAVG + JPEG byte size.

USAGE
  python3 -m venv tools/.venv
  tools/.venv/bin/pip install -r tools/requirements.txt
  # residential proxy comes from SSM /de-clickbait/proxy-url by default (needs AWS creds);
  # or pass --proxy 'http://user-NAME:PASS@gate.decodo.com:7000'
  # datacenter routes only run if you provide a DC endpoint:
  export DC_PROXY_URL='http://user-NAME:PASS@<decodo-dc-endpoint>:<port>'
  tools/.venv/bin/python tools/proxy_cost_test.py            # samples 10 ids from DynamoDB
  tools/.venv/bin/python tools/proxy_cost_test.py --ids dQw4w9WgXcQ,9bZkp7q19f0

Be patient: ample sleeps + jitter between every request and video to stay under bot walls.
"""

import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time

import requests

# ── Config / defaults (mirror handler.py) ───────────────────────────────────────
SSM_PROXY_PARAM = os.environ.get("PROXY_SSM_PARAM", "/de-clickbait/proxy-url")
DDB_TABLE       = os.environ.get("TABLE_NAME", "de-clickbait-titles")
REGION          = os.environ.get("AWS_REGION", "us-west-1")
PLAYER_CLIENT   = os.environ.get("YTDLP_PLAYER_CLIENT", "tv_embedded")
MAX_HEIGHT      = int(os.environ.get("MAX_HEIGHT", "720"))
DC_PROXY_URL    = os.environ.get("DC_PROXY_URL", "").strip()
ISP_PROXY_URL   = os.environ.get("ISP_PROXY_URL", "").strip()
FFMPEG          = os.environ.get("FFMPEG", "ffmpeg")

# Bytes pulled for the residential sweep (we truncate this buffer locally for the floor test).
SWEEP_MAX_BYTES = int(os.environ.get("SWEEP_MAX_BYTES", "1500000"))
# Sizes to test the decode floor at (descending). Truncations of the one residential pull.
SWEEP_SIZES = [1500000, 1100000, 800000, 600000, 450000, 300000]
# Bytes pulled on the alt routes (direct / datacenter) — just enough to prove route + decode.
PROBE_BYTES = int(os.environ.get("PROBE_BYTES", "800000"))

# A black/flat frame: mean luma very low, or JPEG compresses to almost nothing.
MIN_JPEG_BYTES = int(os.environ.get("MIN_JPEG_BYTES", "2000"))
DARK_YAVG      = float(os.environ.get("DARK_YAVG", "16"))

REQ_TIMEOUT = int(os.environ.get("REQ_TIMEOUT", "45"))


def log(msg):
    print(msg, flush=True)


def sleep_jitter(base, label=""):
    if base <= 0:
        return
    d = base + random.uniform(0, base * 0.5)
    if label:
        log(f"    … sleeping {d:.1f}s ({label})")
    time.sleep(d)


# ── Proxy helpers (mirror handler.proxy_with_session) ───────────────────────────
def proxy_with_session(base: str, session: str) -> str:
    if not base or "://" not in base or "@" not in base:
        return base
    scheme, rest = base.split("://", 1)
    userinfo, host = rest.rsplit("@", 1)
    user, _, pw = userinfo.partition(":")
    if "-session-" not in user:
        user = f"{user}-session-{session}"
    return f"{scheme}://{user}:{pw}@{host}"


def new_session() -> str:
    return "%012x" % random.getrandbits(48)


def load_residential_proxy(cli_proxy: str) -> str:
    if cli_proxy:
        return cli_proxy
    env = os.environ.get("PROXY_URL", "").strip()
    if env:
        return env
    try:
        import boto3
        ssm = boto3.client("ssm", region_name=REGION)
        val = ssm.get_parameter(Name=SSM_PROXY_PARAM, WithDecryption=True)["Parameter"]["Value"]
        log(f"[proxy] loaded residential proxy from SSM {SSM_PROXY_PARAM}")
        return val.strip()
    except Exception as e:
        log(f"[proxy] could not load from SSM ({e}); pass --proxy or set PROXY_URL")
        sys.exit(2)


# ── yt-dlp gate + format pick (mirror handler.pick_format) ──────────────────────
def pick_format(info: dict) -> dict:
    vids = [
        f for f in (info.get("formats") or [])
        if f.get("url")
        and f.get("vcodec") not in (None, "none")
        and f.get("acodec") in (None, "none")
        and 0 < (f.get("height") or 0) <= MAX_HEIGHT
    ]
    if not vids:
        vids = [
            f for f in (info.get("formats") or [])
            if f.get("url") and f.get("vcodec") not in (None, "none")
            and 0 < (f.get("height") or 0) <= MAX_HEIGHT
        ]
    if not vids:
        raise RuntimeError(f"no usable video format <= {MAX_HEIGHT}p with a url")

    def rank(f):
        avc = (f.get("vcodec") or "").startswith("avc")
        mp4 = f.get("ext") == "mp4"
        return ((f.get("height") or 0), int(avc) * 2 + int(mp4))

    return max(vids, key=rank)


def gate(video_id: str, proxy: str):
    """Run the yt-dlp metadata gate through `proxy`; return the chosen format dict."""
    import yt_dlp
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True,
        "extractor_args": {"youtube": {"player_client": PLAYER_CLIENT.split(",")}},
    }
    if proxy:
        opts["proxy"] = proxy
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    fmt = pick_format(info)
    return fmt, info


# ── Range fetch + decode/quality check ──────────────────────────────────────────
def range_fetch(url: str, headers: dict, nbytes: int, proxy: str):
    """Return (status, content_bytes, elapsed_s) for a Range GET. Raises on transport error."""
    h = dict(headers or {})
    h["Range"] = f"bytes=0-{nbytes - 1}"
    proxies = {"http": proxy, "https": proxy} if proxy else None
    t0 = time.time()
    r = requests.get(url, headers=h, proxies=proxies, timeout=REQ_TIMEOUT)
    return r.status_code, r.content, time.time() - t0


def signalstats_yavg(jpg_path: str):
    """Mean luma (0-255) of the frame via ffmpeg signalstats, or None."""
    try:
        proc = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "info", "-i", jpg_path,
             "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"],
            capture_output=True, text=True, timeout=30,
        )
        m = re.search(r"signalstats\.YAVG=([0-9.]+)", proc.stdout + proc.stderr)
        return float(m.group(1)) if m else None
    except Exception:
        return None


def decode_frame(buf: bytes):
    """Write buf to a temp file, run the handler's thumbnail filter, return a quality dict."""
    with tempfile.TemporaryDirectory() as d:
        seg, out = os.path.join(d, "seg.bin"), os.path.join(d, "f.jpg")
        with open(seg, "wb") as fh:
            fh.write(buf)
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", seg,
            "-vf", "thumbnail=300,scale='min(1920,iw)':-2",
            "-frames:v", "1", "-update", "1", "-q:v", "3", out,
        ]
        rc = subprocess.run(cmd, capture_output=True, text=True, timeout=60).returncode
        if not (os.path.exists(out) and os.path.getsize(out) >= MIN_JPEG_BYTES):
            return {"ok": False, "jpg": os.path.getsize(out) if os.path.exists(out) else 0,
                    "yavg": None, "rc": rc}
        jpg = os.path.getsize(out)
        yavg = signalstats_yavg(out)
        dark = (yavg is not None and yavg < DARK_YAVG)
        return {"ok": not dark, "jpg": jpg, "yavg": yavg, "rc": rc, "dark": dark}


def fmt_q(q):
    if q is None:
        return "—"
    if not q.get("ok") and q.get("jpg", 0) < MIN_JPEG_BYTES and q.get("rc"):
        return f"FAIL(decode rc={q['rc']})"
    y = f"{q['yavg']:.0f}" if q.get("yavg") is not None else "?"
    tag = "OK" if q["ok"] else ("DARK" if q.get("dark") else "FAIL")
    return f"{tag}(y={y},{q['jpg']//1000}kb)"


# ── Per-video run ───────────────────────────────────────────────────────────────
def run_video(video_id, res_proxy, dc_proxy, args):
    out = {"videoId": video_id, "routes": {}, "sweep": {}}
    log(f"\n=== {video_id} ===")

    # GATE via residential — gives the IP-locked URL + headers for the residential-based
    # routes (R-same / direct / R->DC). If it fails (e.g. residential budget blocked) we
    # skip those but STILL run the all-datacenter route below.
    res_sticky = proxy_with_session(res_proxy, new_session())
    fmt_r = None
    try:
        fmt_r, info = gate(video_id, res_sticky)
        out["height"], out["fmt"] = fmt_r.get("height"), fmt_r.get("format_id")
        log(f"  GATE ok: {info.get('title')!r} -> fmt {fmt_r.get('format_id')} "
            f"{fmt_r.get('width')}x{fmt_r.get('height')} {fmt_r.get('vcodec')}")
    except Exception as e:
        out["gate_error"] = str(e)[:200]
        log(f"  GATE-residential FAILED: {str(e)[:160]}  (still trying datacenter routes)")

    if fmt_r:
        url_r, hdr_r = fmt_r["url"], fmt_r.get("http_headers")

        # 1) R-same: one residential pull at SWEEP_MAX, then a LOCAL truncation floor sweep
        #    (so the whole sweep costs a single residential pull, not one per size).
        sleep_jitter(args.req_sleep, "before R-same fetch")
        try:
            st, buf, el = range_fetch(url_r, hdr_r, SWEEP_MAX_BYTES, res_sticky)
            out["routes"]["R-same"] = {"status": st, "bytes": len(buf), "sec": round(el, 1),
                                       "residential": True}
            log(f"  R-same   : HTTP {st}  {len(buf)/1e6:.2f}MB  {el:.1f}s  (residential)")
            if st in (200, 206) and buf:
                for size in [s for s in SWEEP_SIZES if s <= len(buf)]:
                    q = decode_frame(buf[:size])
                    out["sweep"][size] = q
                    log(f"      sweep @ {size/1e6:.2f}MB -> {fmt_q(q)}")
        except Exception as e:
            out["routes"]["R-same"] = {"error": str(e)[:160], "residential": True}
            log(f"  R-same   : ERROR {str(e)[:120]}")

        # 2) iplock-check: same URL, NO proxy = fetched from THIS machine's (home) IP, which
        #    differs from the gate's Decodo exit IP. This is NOT the production path (the prod
        #    worker is on a Lambda/AWS IP) — it's purely an IP-lock probe: a 200 here means the
        #    segment URL is NOT strictly ip-locked (→ a cheap direct fetch becomes possible,
        #    verify on Lambda); a 403 re-confirms §7's lock (gate+fetch must share an IP).
        sleep_jitter(args.req_sleep, "before iplock-check fetch")
        try:
            st, buf, el = range_fetch(url_r, hdr_r, PROBE_BYTES, None)
            q = decode_frame(buf) if st in (200, 206) and buf else None
            out["routes"]["iplock-check"] = {"status": st, "bytes": len(buf), "sec": round(el, 1),
                                             "residential": False, "decode": fmt_q(q)}
            log(f"  iplock   : HTTP {st}  {len(buf)/1e6:.2f}MB  {el:.1f}s  decode={fmt_q(q)} "
                f"(home IP ≠ gate IP)")
        except Exception as e:
            out["routes"]["iplock-check"] = {"error": str(e)[:160], "residential": False}
            log(f"  iplock   : ERROR {str(e)[:120]}")

        # 3) R->DC: residential URL fetched through the datacenter proxy (cross-IP).
        if dc_proxy:
            sleep_jitter(args.req_sleep, "before R->DC fetch")
            dc_sticky = proxy_with_session(dc_proxy, new_session())
            try:
                st, buf, el = range_fetch(url_r, hdr_r, PROBE_BYTES, dc_sticky)
                q = decode_frame(buf) if st in (200, 206) and buf else None
                out["routes"]["R->DC"] = {"status": st, "bytes": len(buf), "sec": round(el, 1),
                                          "residential": False, "decode": fmt_q(q)}
                log(f"  R->DC    : HTTP {st}  {len(buf)/1e6:.2f}MB  {el:.1f}s  decode={fmt_q(q)}")
            except Exception as e:
                out["routes"]["R->DC"] = {"error": str(e)[:160], "residential": False}
                log(f"  R->DC    : ERROR {str(e)[:120]}")

    # 4) DC-full: gate + fetch ENTIRELY on datacenter (the dream — cheapest GB). Runs
    #    independently of the residential gate so it's still tested if residential is dead.
    if dc_proxy:
        sleep_jitter(args.req_sleep, "before DC gate")
        dc_full = proxy_with_session(dc_proxy, new_session())
        try:
            fmt_d, _ = gate(video_id, dc_full)
            sleep_jitter(args.req_sleep, "before DC-full fetch")
            st, buf, el = range_fetch(fmt_d["url"], fmt_d.get("http_headers"), PROBE_BYTES, dc_full)
            q = decode_frame(buf) if st in (200, 206) and buf else None
            out["routes"]["DC-full"] = {"status": st, "bytes": len(buf), "sec": round(el, 1),
                                        "residential": False, "decode": fmt_q(q), "gate": "ok"}
            log(f"  DC-full  : HTTP {st}  {len(buf)/1e6:.2f}MB  {el:.1f}s  decode={fmt_q(q)}")
        except Exception as e:
            out["routes"]["DC-full"] = {"error": str(e)[:160], "residential": False}
            log(f"  DC-full  : ERROR (gate or fetch) {str(e)[:120]}")
    else:
        log("  (skipping datacenter routes — set DC_PROXY_URL to test them)")

    return out


# ── Sampling video IDs ──────────────────────────────────────────────────────────
def sample_ids_from_dynamo(n):
    import boto3
    ddb = boto3.client("dynamodb", region_name=REGION)
    ids = []
    kwargs = {"TableName": DDB_TABLE, "ProjectionExpression": "videoId, thumbStatus",
              "Limit": 300}
    resp = ddb.scan(**kwargs)
    yt_id = re.compile(r"^[A-Za-z0-9_-]{11}$")   # real YouTube ids only (skip test rows like "vid3")
    for it in resp.get("Items", []):
        if it.get("thumbStatus", {}).get("S") == "unavailable":
            continue
        vid = it.get("videoId", {}).get("S")
        if vid and yt_id.match(vid):
            ids.append(vid)
    if not ids:
        raise RuntimeError(f"no eligible videoIds found in {DDB_TABLE}")
    random.shuffle(ids)
    return ids[:n]


# ── Summary ─────────────────────────────────────────────────────────────────────
def summarize(results):
    log("\n" + "=" * 72)
    log("SUMMARY")
    log("=" * 72)
    routes = ["R-same", "iplock-check", "R->DC", "DC-full"]
    tally = {r: {"ok": 0, "tried": 0} for r in routes}
    for res in results:
        for r in routes:
            info = res.get("routes", {}).get(r)
            if not info:
                continue
            tally[r]["tried"] += 1
            st = info.get("status")
            dec = info.get("decode", "")
            good = st in (200, 206) and (r == "R-same" or dec.startswith("OK"))
            if good:
                tally[r]["ok"] += 1
    for r in routes:
        t = tally[r]
        if t["tried"]:
            log(f"  {r:<13}: worked {t['ok']}/{t['tried']}")

    # FETCH_BYTES floor: smallest sweep size that decoded OK on every video that had a sweep.
    sized = {}
    nsweep = 0
    for res in results:
        if not res.get("sweep"):
            continue
        nsweep += 1
        for size, q in res["sweep"].items():
            sized.setdefault(int(size), []).append(bool(q.get("ok")))
    if sized:
        log(f"\n  FETCH_BYTES floor sweep (over {nsweep} videos):")
        floor = None
        for size in sorted(sized, reverse=True):
            oks = sized[size]
            rate = sum(oks)
            log(f"    {size/1e6:>4.2f}MB : clean {rate}/{len(oks)}")
            if rate == len(oks):
                floor = size
        if floor is not None:
            log(f"  -> smallest size clean on ALL videos: {floor/1e6:.2f}MB "
                f"(vs current 1.50MB).")

    # Verdict on getting the fetch off residential.
    log("\n  VERDICT:")
    d = tally["iplock-check"]; rdc = tally["R->DC"]; dcf = tally["DC-full"]
    if d["tried"] and d["ok"] == d["tried"]:
        log("    ❗ iplock-check passed from a DIFFERENT IP (home) than the gate → the "
            "segment URL is NOT strictly ip-locked. A cheap direct fetch may be possible; "
            "verify from a Lambda/AWS IP before trusting it (home IP ≠ prod IP).")
    elif d["tried"]:
        log(f"    ✅ iplock-check failed {d['tried']-d['ok']}/{d['tried']} (403 from a non-gate "
            "IP) → confirms §7: gate + fetch must share an IP. Cheapest path = a cheaper "
            "GATE IP (datacenter), not dropping the proxy.")
    if rdc["tried"]:
        msg = "✅ works → fetch via cheaper datacenter, gate on residential" if rdc["ok"] == rdc["tried"] \
              else f"❌ {rdc['ok']}/{rdc['tried']} (cross-IP blocked)"
        log(f"    R->DC: {msg}")
    if dcf["tried"]:
        msg = "✅ full datacenter pipeline works → migrate gate+fetch to datacenter $/GB" \
              if dcf["ok"] == dcf["tried"] else f"❌ {dcf['ok']}/{dcf['tried']} (gate wall persists, §7)"
        log(f"    DC-full: {msg}")
    if not (d["tried"] or rdc["tried"] or dcf["tried"]):
        log("    (only the FETCH_BYTES sweep ran — set DC_PROXY_URL to test off-residential routes)")


def main():
    ap = argparse.ArgumentParser(description="Decodo proxy cost probe (THUMBNAIL_PIPELINE §16)")
    ap.add_argument("--proxy", default="", help="residential proxy url (else SSM/PROXY_URL)")
    ap.add_argument("--ids", default="", help="comma-separated videoIds (else sample DynamoDB)")
    ap.add_argument("--count", type=int, default=10, help="how many ids to sample (default 10)")
    ap.add_argument("--req-sleep", type=float, default=4.0,
                    help="base seconds between requests (+50%% jitter), default 4")
    ap.add_argument("--video-sleep", type=float, default=10.0,
                    help="base seconds between videos (+50%% jitter), default 10")
    ap.add_argument("--out", default="", help="write JSON results to this path")
    args = ap.parse_args()

    res_proxy = load_residential_proxy(args.proxy)
    dc_proxy = DC_PROXY_URL or ISP_PROXY_URL

    if args.ids:
        ids = [s.strip() for s in args.ids.split(",") if s.strip()]
    else:
        ids = sample_ids_from_dynamo(args.count)
    log(f"[run] {len(ids)} videos | residential proxy set | datacenter={'yes' if dc_proxy else 'no'}")
    log(f"[run] ids: {', '.join(ids)}")

    results = []
    for i, vid in enumerate(ids):
        results.append(run_video(vid, res_proxy, dc_proxy, args))
        if i < len(ids) - 1:
            sleep_jitter(args.video_sleep, "between videos")

    summarize(results)

    out_path = args.out or os.path.join(tempfile.gettempdir(), "proxy_cost_results.json")
    with open(out_path, "w") as fh:
        json.dump(results, fh, indent=2, default=str)
    log(f"\n[run] raw results -> {out_path}")


if __name__ == "__main__":
    main()
