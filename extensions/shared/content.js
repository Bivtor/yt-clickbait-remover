// De-Clickbait — content script
// Collects video cards, sends ONE batch request, swaps clickbait titles + thumbnails.

const API_BASE = "https://u2qi2puu47.execute-api.us-west-1.amazonaws.com";

console.log("[De-Clickbait] content script loaded");

// ── Card selectors ─────────────────────────────────────────────────────────────
// Confirmed via console on live YouTube (2024+ layout):
//   yt-lockup-view-model       102  ← actual video card component (home/subscriptions)
//   ytd-rich-item-renderer     107  ← outer wrapper (includes non-video rows, less precise)
//   ytd-rich-grid-media          0  ← DOES NOT EXIST on current YouTube
//
// For other page types we include classic selectors; dataset.dc guards against double-processing.
const CARD_SELECTOR = [
  "yt-lockup-view-model",          // Home page, Subscriptions (confirmed 102 matches)
  "ytd-video-renderer",            // Search results
  "ytd-compact-video-renderer",    // Watch page sidebar (Up Next / recommended)
  "ytd-grid-video-renderer",       // Channel page grid
  "ytd-playlist-video-renderer",   // Playlist items
].join(", ");

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractVideoId(href) {
  try { return new URL(href).searchParams.get("v"); } catch { return null; }
}

// ── Card info extraction ───────────────────────────────────────────────────────
// YouTube uses two distinct DOM architectures:
//
// NEW (2024+) — yt-lockup-view-model inside ytd-rich-grid-media:
//   h3[title] attribute holds the title
//   a.ytLockupMetadataViewModelTitle > span[title] holds the visible text
//   .ytThumbnailViewModelImage img holds the thumbnail
//
// CLASSIC — ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer:
//   yt-formatted-string#video-title or span#video-title holds the title text
//   ytd-thumbnail img holds the thumbnail

function getCardInfo(card) {
  // Shorts use /shorts/ID links — the /watch?v= check below skips them automatically.
  const anchor = card.querySelector("a[href*='/watch?v=']");
  if (!anchor) return null;
  const videoId = extractVideoId(anchor.href);
  if (!videoId) return null;

  // ── Title elements (try new lockup first, then classic) ──────────────────────
  const h3         = card.querySelector("h3[title]");
  const titleLink  = card.querySelector("a.ytLockupMetadataViewModelTitle");
  // YouTube removed the [title] attribute from this span; query by first span instead
  const visibleSpan = titleLink?.querySelector("span");
  const classicTitleEl = card.querySelector("yt-formatted-string#video-title, span#video-title");

  const originalTitle = (
    h3?.getAttribute("title")?.trim()
    ?? classicTitleEl?.textContent?.trim()
    ?? anchor.getAttribute("title")?.trim()
  );
  if (!originalTitle) return null;

  // ── Creator ───────────────────────────────────────────────────────────────────
  const creator = (
    card.querySelector("a[href^='/@']")?.firstChild?.textContent?.trim()
    ?? card.querySelector("ytd-channel-name yt-formatted-string")?.textContent?.trim()
    ?? ""
  );

  // ── Thumbnail ─────────────────────────────────────────────────────────────────
  const thumbImg = card.querySelector(".ytThumbnailViewModelImage img, ytd-thumbnail img");

  return { videoId, originalTitle, creator, h3, visibleSpan, titleLink, classicTitleEl, thumbImg };
}

// ── Canvas frame capture (DeArrow approach) ────────────────────────────────────
// POST to YouTube's InnerTube API (same-origin from youtube.com content script)
// to get signed adaptive stream URLs. Then:
//   1. Create a hidden <video crossOrigin="anonymous"> element
//   2. Wait for loadedmetadata, then seek to 33% of duration
//   3. On seeked, drawImage onto canvas → toBlob → blobUrl → swap img.src
//
// googlevideo.com serves Access-Control-Allow-Origin: * on adaptive streams,
// so the canvas does not get tainted and toBlob() succeeds.
// Firefox needs play()→pause() before seeking or it renders a black frame.

const MAX_RENDERS = 3;
let activeRenderCount = 0;
const renderQueue = [];

function acquireRenderSlot() {
  if (activeRenderCount < MAX_RENDERS) {
    activeRenderCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => renderQueue.push(() => { activeRenderCount++; resolve(); }));
}

function releaseRenderSlot() {
  activeRenderCount--;
  renderQueue.shift()?.();
}

// Read YouTube's own InnerTube context from the page.
// Firefox MV2: wrappedJSObject exposes the page's actual window globals.
// This gives us the current client version, visitorData, and auth context —
// without it YouTube returns UNPLAYABLE for our hardcoded client version.
function getYtcfgData() {
  try {
    const w = window.wrappedJSObject ?? window;
    return w.ytcfg?.data_ ?? null;
  } catch { return null; }
}

async function fetchStreamInfo(videoId) {
  try {
    const ytcfg = getYtcfgData();
    const context = ytcfg?.INNERTUBE_CONTEXT
      ?? { client: { clientName: "WEB", clientVersion: "2.20230327.07.00" } };

    const body = { context, videoId };
    if (ytcfg?.STS) {
      body.playbackContext = { contentPlaybackContext: { signatureTimestamp: ytcfg.STS } };
    }

    const resp = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { console.log(`[DC] fetchStream ${videoId}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const status = data?.playabilityStatus?.status;
    if (status === "LOGIN_REQUIRED") { console.log(`[DC] fetchStream ${videoId}: LOGIN_REQUIRED`); return null; }

    const duration = parseInt(data?.videoDetails?.lengthSeconds ?? "0");
    if (!duration || duration < 5) { console.log(`[DC] fetchStream ${videoId}: no duration`); return null; }

    // Log storyboard spec so we can see if it's a viable path
    const sbSpec = data?.storyboards?.playerStoryboardSpecRenderer?.spec;
    console.log(`[DC] fetchStream ${videoId}: storyboard spec=`, sbSpec?.slice(0, 120) ?? "none");

    const rawFormats = data?.streamingData?.adaptiveFormats ?? [];
    console.log(`[DC] fetchStream ${videoId}: ${rawFormats.length} raw formats, first keys:`, rawFormats[0] ? Object.keys(rawFormats[0]).join(", ") : "none");

    const formats = rawFormats
      .filter(f => f.url && f.width && f.height && f.mimeType?.startsWith("video/"));
    if (!formats.length) { console.log(`[DC] fetchStream ${videoId}: no direct-url formats (status=${status})`); return null; }

    formats.sort((a, b) => a.width - b.width);
    const format = formats.find(f => f.width >= 640) ?? formats[formats.length - 1];
    console.log(`[DC] fetchStream ${videoId}: ${format.width}x${format.height} ${duration}s`);
    return { url: format.url, duration };
  } catch (e) { console.log(`[DC] fetchStream ${videoId} error:`, e.message); return null; }
}

async function captureFrame(videoId, thumbImg) {
  console.log(`[DC] captureFrame start ${videoId}`);
  const info = await fetchStreamInfo(videoId);
  if (!info) { console.log(`[DC] captureFrame ${videoId}: no stream info`); return; }
  if (!thumbImg.isConnected) { console.log(`[DC] captureFrame ${videoId}: img disconnected`); return; }

  const { url, duration } = info;
  const ts = Math.max(1, Math.floor(duration * 0.33));
  console.log(`[DC] captureFrame ${videoId}: seeking to ${ts}s`);

  await acquireRenderSlot();
  try {
    await new Promise(resolve => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.volume = 0;
      video.preload = "auto";

      let done = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        console.log(`[DC] captureFrame ${videoId}: finish(${reason})`);
        clearTimeout(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
        resolve();
      };
      const timer = setTimeout(() => finish("timeout"), 20000);

      const drawFrame = () => {
        if (done) return;
        console.log(`[DC] captureFrame ${videoId}: drawFrame readyState=${video.readyState} seeking=${video.seeking}`);
        if (video.readyState < 2 || video.seeking) {
          video.addEventListener("seeked", drawFrame, { once: true });
          return;
        }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 360;
          canvas.getContext("2d").drawImage(video, 0, 0);
          canvas.toBlob(blob => {
            console.log(`[DC] captureFrame ${videoId}: blob=${blob?.size} connected=${thumbImg.isConnected}`);
            if (blob && thumbImg.isConnected) {
              thumbImg.src = URL.createObjectURL(blob);
              console.log(`[DC] captureFrame ${videoId}: applied blob URL`);
            }
            finish("blob");
          }, "image/jpeg", 0.85);
        } catch (e) { finish(`draw-err:${e.message}`); }
      };

      const seekToTimestamp = () => {
        if (done) return;
        console.log(`[DC] captureFrame ${videoId}: loadedmetadata, seeking to ${ts}`);
        video.currentTime = ts;
        video.addEventListener("seeked", drawFrame, { once: true });
      };

      video.addEventListener("error", (e) => finish(`video-error:${video.error?.code}`), { once: true });
      video.addEventListener("loadedmetadata", seekToTimestamp, { once: true });

      if (navigator.userAgent.includes("Firefox")) {
        video.src = url;
        video.play()
          .then(() => { video.pause(); })
          .catch((e) => console.log(`[DC] captureFrame ${videoId}: play() rejected:`, e.message));
      } else {
        video.src = `${url}#t=${ts}`;
      }
    });
  } finally {
    releaseRenderSlot();
  }
}

// ── Thumbnail swap ─────────────────────────────────────────────────────────────
// Two-pass:
//   Pass 1 (instant): replace with sddefault.jpg — YouTube's auto-generated
//     640×480 frame, not the creator's hand-picked clickbait image.
//   Pass 2 (async): capture the actual video frame at 33% via canvas.

function swapThumbnail(videoId, thumbImg) {
  if (!thumbImg || thumbImg.dataset.dcThumb) return;
  thumbImg.dataset.dcThumb = "1";

  const sdUrl = `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`;
  let frameStarted = false;

  const apply = (url) => {
    // Remove srcset — browser prefers it over src, so clearing it forces our src to render
    thumbImg.removeAttribute("srcset");
    thumbImg.src = url;
    if (!frameStarted && url === sdUrl) {
      frameStarted = true;
      captureFrame(videoId, thumbImg);
    }
  };

  // YouTube lazy-loads thumbnails via IntersectionObserver: img.src is empty when the card
  // renders, then YouTube sets it when the card enters the viewport — overwriting our src.
  // This guard re-applies our URL whenever YouTube reverts it.
  const guard = new MutationObserver(() => {
    const cur = thumbImg.src;
    if (cur && cur !== sdUrl && !cur.startsWith("blob:")) {
      apply(sdUrl);
    }
  });
  guard.observe(thumbImg, { attributes: true, attributeFilter: ["src", "srcset"] });

  // Always apply immediately. Setting src triggers the fetch regardless of visibility.
  // The guard handles YouTube reverting it when its lazy-loader fires later.
  apply(sdUrl);

  // Stop guarding after 30s — the card is long since rendered by then
  setTimeout(() => guard.disconnect(), 30000);
}

// ── Apply rewritten title ──────────────────────────────────────────────────────
// Handles both new lockup layout and classic ytd-* layout.

function applyTitle(info, rewrittenTitle) {
  const { h3, visibleSpan, titleLink, classicTitleEl, originalTitle } = info;

  // New lockup layout (inside ytd-rich-grid-media on home/subscriptions)
  if (visibleSpan) {
    visibleSpan.textContent = rewrittenTitle;
  }
  if (h3) {
    h3.setAttribute("title", rewrittenTitle);
    h3.setAttribute("aria-label", rewrittenTitle);
  }

  // Classic layout (ytd-video-renderer, ytd-compact-video-renderer, etc.)
  if (classicTitleEl) {
    classicTitleEl.textContent = rewrittenTitle;
    if (classicTitleEl.hasAttribute("title")) classicTitleEl.setAttribute("title", rewrittenTitle);
  }

  if (titleLink) titleLink.dataset.dcOriginal = originalTitle;
}

// ── Core: one batch request for all unprocessed cards on the page ──────────────

async function processAllCards() {
  const all = [...document.querySelectorAll(CARD_SELECTOR)];
  const unprocessed = all.filter(card => !card.dataset.dc);

  console.log(`[DC] processAllCards: ${all.length} total cards, ${unprocessed.length} unprocessed`);
  if (!unprocessed.length) return;

  const entries = unprocessed.map(card => {
    card.dataset.dc = "loading";
    return { card, info: getCardInfo(card) };
  });

  entries.forEach(({ card, info }) => {
    if (!info) card.dataset.dc = "skip";
  });

  const valid = entries.filter(({ info }) => info !== null);
  console.log(`[DC] valid: ${valid.length}, skipped: ${entries.length - valid.length}`);
  if (!valid.length) return;

  console.log("[DC] sample card info:", valid[0]?.info);

  // Swap thumbnails immediately — no API roundtrip needed for this
  valid.forEach(({ info }) => swapThumbnail(info.videoId, info.thumbImg));

  // Deduplicate by videoId before sending to API
  const seen = new Set();
  const videos = [];
  for (const { info } of valid) {
    if (!seen.has(info.videoId)) {
      seen.add(info.videoId);
      videos.push({ videoId: info.videoId, title: info.originalTitle, creator: info.creator });
    }
  }

  try {
    console.log(`[DC] POST /titles with ${videos.length} videos`);
    const resp = await fetch(`${API_BASE}/titles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
    });

    console.log(`[DC] API response: ${resp.status}`);
    if (!resp.ok) {
      valid.forEach(({ card }) => { card.dataset.dc = "err"; });
      return;
    }

    const { results } = await resp.json();
    console.log("[DC] results:", results);

    for (const { card, info } of valid) {
      const result = results?.[info.videoId];
      if (!result) { card.dataset.dc = "err"; continue; }

      if (result.status === "hit" && result.rewrittenTitle && result.rewrittenTitle !== info.originalTitle) {
        console.log(`[DC] apply "${result.rewrittenTitle}" | h3=${!!info.h3} span=${!!info.visibleSpan} classic=${!!info.classicTitleEl} orig="${info.originalTitle}"`);
        applyTitle(info, result.rewrittenTitle);
        card.dataset.dc = "done";
      } else {
        card.dataset.dc = result.status ?? "pending";
      }
    }
  } catch (e) {
    console.error("[DC] fetch error:", e);
    valid.forEach(({ card }) => { card.dataset.dc = "err"; });
  }
}

// ── MutationObserver + SPA navigation ─────────────────────────────────────────

let debounceTimer;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(processAllCards, 300);
});

observer.observe(document.body, { childList: true, subtree: true });

document.addEventListener("yt-navigate-finish", () => {
  clearTimeout(debounceTimer);
  processAllCards();
});

processAllCards();
