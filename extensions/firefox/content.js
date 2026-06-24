// De-Clickbait — content script
// Collects video cards, sends ONE batch request, swaps clickbait titles + thumbnails.
//
// Thumbnails now come from OUR server: the /titles response carries a `thumbUrl`
// (CloudFront URL of a server-extracted frame). The old client-side frame-capture
// approach (hidden <video> + canvas) was removed — it was unreliable (canvas taint /
// DRM / black frames) and is replaced by server-side extraction.

const API_BASE = "https://u2qi2puu47.execute-api.us-west-1.amazonaws.com";

console.log("[De-Clickbait] content script loaded");

// ── Card selectors ─────────────────────────────────────────────────────────────
// Confirmed via console on live YouTube (2024+ layout):
//   yt-lockup-view-model       ← actual video card component (home/subscriptions)
// For other page types we include classic selectors; dataset.dc guards double-processing.
const CARD_SELECTOR = [
  "yt-lockup-view-model",          // Home page, Subscriptions
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
// NEW (2024+) lockup: h3[title] holds the title; a.ytLockupMetadataViewModelTitle > span
//   holds visible text; .ytThumbnailViewModelImage img holds the thumbnail.
// CLASSIC ytd-*: yt-formatted-string#video-title / span#video-title; ytd-thumbnail img.

function getCardInfo(card) {
  // Shorts use /shorts/ID links — the /watch?v= check below skips them automatically.
  const anchor = card.querySelector("a[href*='/watch?v=']");
  if (!anchor) return null;
  const videoId = extractVideoId(anchor.href);
  if (!videoId) return null;

  const h3           = card.querySelector("h3[title]");
  const titleLink    = card.querySelector("a.ytLockupMetadataViewModelTitle");
  const visibleSpan  = titleLink?.querySelector("span");
  const classicTitleEl = card.querySelector("yt-formatted-string#video-title, span#video-title");

  const originalTitle = (
    h3?.getAttribute("title")?.trim()
    ?? classicTitleEl?.textContent?.trim()
    ?? anchor.getAttribute("title")?.trim()
  );
  if (!originalTitle) return null;

  const creator = (
    card.querySelector("a[href^='/@']")?.firstChild?.textContent?.trim()
    ?? card.querySelector("ytd-channel-name yt-formatted-string")?.textContent?.trim()
    ?? ""
  );

  const thumbImg = card.querySelector(".ytThumbnailViewModelImage img, ytd-thumbnail img");

  return { videoId, originalTitle, creator, h3, visibleSpan, titleLink, classicTitleEl, thumbImg };
}

// ── Thumbnail swap ─────────────────────────────────────────────────────────────
// We do NOT mutate YouTube's own <img>.src — its yt-core-image component owns that
// element and resets src on render/scroll, so we'd lose a fighting match. Instead we
// OVERLAY our own <img> on top of YouTube's thumbnail. YouTube's render loop never
// touches an element it doesn't manage, so the overlay sticks. Idempotent +
// self-healing: re-creates the overlay if YouTube ever removes it.

function swapThumbnail(thumbImg, thumbUrl) {
  if (!thumbUrl) return;
  if (!thumbImg) { console.log(`[DC] swapThumbnail: NO <img> element found for ${thumbUrl}`); return; }

  const host = thumbImg.parentElement;
  if (!host) { console.log(`[DC] swapThumbnail: <img> has no parent for ${thumbUrl}`); return; }

  let overlay = host.querySelector(":scope > img.dc-thumb-overlay");
  if (overlay && overlay.dataset.dcThumb === thumbUrl) return;   // already overlaid this frame

  if (!overlay) {
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    overlay = document.createElement("img");
    overlay.className = "dc-thumb-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;pointer-events:none;";
    host.appendChild(overlay);
  }
  overlay.dataset.dcThumb = thumbUrl;
  overlay.src = thumbUrl;
  thumbImg.dataset.dcThumb = thumbUrl;
  console.log(`[DC] overlaid thumbnail -> ${thumbUrl}`);
}

// ── Apply rewritten title ──────────────────────────────────────────────────────

function applyTitle(info, rewrittenTitle) {
  const { h3, visibleSpan, titleLink, classicTitleEl, originalTitle } = info;

  if (visibleSpan) visibleSpan.textContent = rewrittenTitle;
  if (h3) {
    h3.setAttribute("title", rewrittenTitle);
    h3.setAttribute("aria-label", rewrittenTitle);
  }
  if (classicTitleEl) {
    classicTitleEl.textContent = rewrittenTitle;
    if (classicTitleEl.hasAttribute("title")) classicTitleEl.setAttribute("title", rewrittenTitle);
  }
  if (titleLink) titleLink.dataset.dcOriginal = originalTitle;
}

// ── Core: one batch request for all unprocessed cards on the page ──────────────
// Title and thumbnail resolve INDEPENDENTLY and may arrive on different loads (the
// thumbnail worker is separate + slower). So we keep re-querying a card until BOTH
// are applied, up to MAX_TRIES, then give up (the card just keeps whatever it has).

const MAX_TRIES = 6;

async function processAllCards() {
  const all = [...document.querySelectorAll(CARD_SELECTOR)];
  // Reprocess anything not finished or skipped (covers undefined, "pending", "err").
  const unprocessed = all.filter(card => card.dataset.dc !== "done" && card.dataset.dc !== "skip");
  if (!unprocessed.length) return;

  const entries = unprocessed.map(card => ({ card, info: getCardInfo(card) }));
  entries.forEach(({ card, info }) => { if (!info) card.dataset.dc = "skip"; });

  const valid = entries.filter(({ info }) => info !== null);
  if (!valid.length) return;

  // Stash the TRUE original title once, so re-queries don't read a title we already
  // rewrote in the DOM. Use the stashed value for the request + comparison.
  for (const { card, info } of valid) {
    if (!card.dataset.dcOrig) card.dataset.dcOrig = info.originalTitle;
  }

  // Deduplicate by videoId before sending to the API.
  const seen = new Set();
  const videos = [];
  for (const { card, info } of valid) {
    if (!seen.has(info.videoId)) {
      seen.add(info.videoId);
      videos.push({ videoId: info.videoId, title: card.dataset.dcOrig, creator: info.creator });
    }
  }

  try {
    const resp = await fetch(`${API_BASE}/titles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
    });
    if (!resp.ok) {
      valid.forEach(({ card }) => { card.dataset.dc = "err"; });
      return;
    }

    const { results } = await resp.json();

    const ids = Object.keys(results ?? {});
    console.log(`[DC] /titles → ${ids.length} results | hits=${ids.filter(id => results[id].status === "hit").length} | withThumb=${ids.filter(id => results[id].thumbUrl).length}`);

    for (const { card, info } of valid) {
      const result = results?.[info.videoId];
      if (!result) { card.dataset.dc = "err"; continue; }

      // Diagnostic: status, returned thumbUrl (open it to verify CloudFront), and whether
      // we even located the card's <img> element to swap.
      console.log(`[DC] ${info.videoId} status=${result.status} thumbImg=${info.thumbImg ? "found" : "MISSING"} thumb=${result.thumbUrl ?? "—"} title=${result.rewrittenTitle ? JSON.stringify(result.rewrittenTitle) : "—"}`);

      const original = card.dataset.dcOrig ?? info.originalTitle;

      // Thumbnail — apply whenever the server has one (independent of the title).
      if (result.thumbUrl) swapThumbnail(info.thumbImg, result.thumbUrl);

      // Title — apply on a hit (skip if it's already the same text).
      const titleResolved = result.status === "hit" && !!result.rewrittenTitle;
      if (titleResolved && result.rewrittenTitle !== original) {
        applyTitle({ ...info, originalTitle: original }, result.rewrittenTitle);
      }

      // Finished only when BOTH are in. Otherwise retry on later ticks (bounded).
      if (titleResolved && result.thumbUrl) {
        card.dataset.dc = "done";
      } else {
        const tries = parseInt(card.dataset.dcTries ?? "0", 10) + 1;
        card.dataset.dcTries = String(tries);
        card.dataset.dc = tries >= MAX_TRIES ? "done" : "pending";
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
