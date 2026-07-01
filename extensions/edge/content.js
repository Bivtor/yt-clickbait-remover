// De-Clickbait — content script
// Collects video cards, sends ONE batch request, swaps clickbait titles + thumbnails.
//
// Thumbnails come from OUR server: the /titles response carries a `thumbUrl`
// (CloudFront URL of a server-extracted frame). The old client-side frame-capture
// approach (hidden <video> + canvas) was removed — unreliable (canvas taint / DRM /
// black frames) and is replaced by server-side extraction.
//
// ── P0: NO-FLASH LOADING (THUMBNAIL_PIPELINE §15) ───────────────────────────────
// The flash isn't a timing bug we can out-run — the data lives on our server and needs
// a round-trip, so at first paint we don't have it yet. Instead of showing YouTube's
// clickbait original and then swapping it (the flash), we HIDE the original until our
// data is ready, then reveal. The user sees `placeholder → clean`, never `clickbait →
// clean`. There is no visible swap because the clickbait version was never shown.
//
// Mechanism: a CSS gate injected at document_start (before YouTube paints). It is a
// STANDING, session-long rule keyed on card-level data-attributes we control, so it masks
// the initial feed AND every later card (infinite scroll, "Show more") uniformly, at
// DOM-insert time, with no JS race. JS flips the attributes PER CARD once it has applied
// (or decided to give up on) that card — there is no global reveal, so late-loaded cards
// never flash their original. A server outage or hung request can't strand a card either:
// each request is bounded by an AbortController timeout, and every card releases its masks
// at the CURE_MS deadline regardless.
//
//   Title axis (card[data-dc-title]):  absent → hidden (loading);  present → revealed.
//   Thumb axis (card[data-dc-thumb]):  absent → dark cover (loading)
//                                      "hit"  → our overlay frame shown (cover gone)
//                                      "miss" → BLACK cover, fades in on hover to reveal
//                                               the original (the agreed miss treatment)
//                                      "orig" → original shown as-is (hard error fallback)
//
//   Hit  (cached): mask → reveal clean. True no-flash.
//   Miss (uncached): title reveals the original; thumb blacks out (hover to peek) until
//                    re-query/polling cures it. Never shows a clickbait *thumbnail*.

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

// Inner targets the CSS gate masks (kept in sync with getCardInfo's queries).
// Shimmer target: the INNER text span of the lockup title (hugs the text, not the wider
// <a> block), plus the classic text elements which already are the text node.
const TITLE_SEL = "a.ytLockupMetadataViewModelTitle > span, yt-formatted-string#video-title, span#video-title";
const THUMB_SEL = ".ytThumbnailViewModelImage, ytd-thumbnail";

// ── P0: CSS gate (injected at document_start, before first paint) ───────────────
// A STANDING rule keyed only on card-level data-attributes we control. It masks the
// initial feed AND every later-loaded card (infinite scroll, "Show more") uniformly, at
// DOM-insert time, with no JS race — and stays active the whole session. Masks are
// released PER CARD (JS sets the attributes); there is no global reveal, so late cards
// never flash their original. Robustness comes from the per-card cure deadline + an
// AbortController fetch timeout (see below), not a session-wide failsafe.

// Shorts to hide when the "Hide Shorts" toggle is on. :has() (modern browsers) makes this
// robust across surfaces (home shelf, search/subs/watch reels, individual grid items, nav).
const SHORTS_SEL = [
  "ytd-reel-shelf-renderer",
  "ytd-rich-shelf-renderer[is-shorts]",
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
  'ytd-rich-shelf-renderer:has(a[href^="/shorts/"])',
  'ytd-rich-section-renderer:has(a[href^="/shorts/"])',
  'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
  'ytd-video-renderer:has(a[href^="/shorts/"])',
  'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
  'grid-shelf-view-model:has(a[href^="/shorts/"])',
  'ytd-guide-entry-renderer:has(a[href="/shorts"])',
  'ytd-mini-guide-entry-renderer:has(a[href="/shorts"])',
].join(", ");

// The gate rules are gated by root attributes the popup toggles set on <html>:
//   data-dc-titles="off"  → don't mask/replace titles (show YouTube's original)
//   data-dc-thumbs="off"  → don't mask/replace thumbnails (hide our overlay, show original)
//   data-dc-shorts="hide" → remove Shorts shelves + recommendations
// Defaults (attribute absent) = everything ON.
const GATE_CSS = `
/* Subtle loading shimmer (dark theme): a soft highlight sweeping across the placeholder,
   so a not-yet-ready card reads as "loading" instead of a dead black/blank. */
@keyframes dc-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
/* Thumbnail variant: slower + sparse — one narrow highlight sweeps, then holds dark for
   most of the cycle (not a constant shimmer). */
@keyframes dc-shimmer-thumb {
  0%   { background-position: 130% 0; }
  35%  { background-position: -30% 0; }
  100% { background-position: -30% 0; }
}

/* TITLE loading — hide the text but show a shimmering skeleton bar (not a blank line).
   color:transparent keeps the element's geometry so the shimmer sits where the title is.
   Disabled when titles are toggled off (original shows immediately, no mask). */
:root:not([data-dc-titles="off"]) :is(${CARD_SELECTOR}):not([data-dc-title]) :is(${TITLE_SEL}) {
  color: transparent !important;
  border-radius: 4px;
  background-image: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.11) 37%, rgba(255,255,255,0.04) 63%);
  background-size: 200% 100%;
  animation: dc-shimmer 1.4s ease-in-out infinite;
}

/* THUMB loading — shimmering dark cover until we know hit vs miss (no clickbait shown). */
:root:not([data-dc-thumbs="off"]) :is(${CARD_SELECTOR}):not([data-dc-thumb]) :is(${THUMB_SEL}) {
  position: relative;
}
:root:not([data-dc-thumbs="off"]) :is(${CARD_SELECTOR}):not([data-dc-thumb]) :is(${THUMB_SEL})::after {
  content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
  background-color: #0f0f0f;
  background-image: linear-gradient(100deg, transparent 45%, rgba(255,255,255,0.05) 50%, transparent 55%);
  background-size: 250% 100%;
  animation: dc-shimmer-thumb 4.5s ease-in-out infinite;
}

/* THUMB miss — solid BLACK over the original; fades in gently on hover so the user can
   peek the original. Set only at the terminal cure deadline (a decision, not a stall). */
:root:not([data-dc-thumbs="off"]) :is(${CARD_SELECTOR})[data-dc-thumb="miss"] :is(${THUMB_SEL}) {
  position: relative;
}
:root:not([data-dc-thumbs="off"]) :is(${CARD_SELECTOR})[data-dc-thumb="miss"] :is(${THUMB_SEL})::after {
  content: ""; position: absolute; inset: 0; background: #000; z-index: 2; pointer-events: none;
  opacity: 1; transition: opacity .45s ease;
}
:root:not([data-dc-thumbs="off"]) :is(${CARD_SELECTOR})[data-dc-thumb="miss"] :is(${THUMB_SEL}):hover::after {
  opacity: 0;
}
/* "hit" and "orig" carry the attribute but match no ::after rule → cover gone. */

/* Toggle OFF thumbnails: hide our overlay frame → YouTube's original thumbnail shows. */
:root[data-dc-thumbs="off"] .dc-thumb-overlay { display: none !important; }

/* Toggle ON "Hide Shorts": remove Shorts shelves + recommendations across the site. */
:root[data-dc-shorts="hide"] :is(${SHORTS_SEL}) { display: none !important; }
`;

function injectGateCss() {
  if (document.getElementById("dc-gate-style")) return;
  const style = document.createElement("style");
  style.id = "dc-gate-style";
  style.textContent = GATE_CSS;
  // documentElement always exists at document_start (head/body may not yet).
  (document.head || document.documentElement).appendChild(style);
}

// ── Settings (popup toggles) ────────────────────────────────────────────────────
// We ALWAYS fetch + store both the original and our rewrite/thumbnail, so the toggles
// can flip live (no reload): titles swap via JS (displayCardTitle), thumbnails + Shorts
// are pure CSS via root attributes. Defaults: everything ON.

const titlesOn = () => document.documentElement.dataset.dcTitles !== "off";

function applySettings(s) {
  const de = document.documentElement;
  de.dataset.dcTitles = s && s.titles     === false ? "off"  : "on";
  de.dataset.dcThumbs = s && s.thumbs     === false ? "off"  : "on";
  de.dataset.dcShorts = s && s.hideShorts === false ? "show" : "hide";
}

// Settings-aware title render: rewrite when titles are ON and we have one, else original.
function displayCardTitle(card, info) {
  info = info || getCardInfo(card);
  if (!info) return;
  const original  = card.dataset.dcOrig ?? info.originalTitle;
  const rewritten = card.dataset.dcRewritten;
  const text = (titlesOn() && rewritten) ? rewritten : original;
  applyTitle({ ...info, originalTitle: original }, text);
}

function reRenderAllTitles() {
  for (const card of document.querySelectorAll(CARD_SELECTOR)) {
    if (card.dataset.dcRewritten) displayCardTitle(card);
  }
  reRenderWatchTitle();
}

function loadSettings() {
  applySettings({});   // synchronous defaults (all ON, Shorts hidden) → no flash at document_start
  try {
    chrome.storage.local.get("dcSettings", ({ dcSettings }) => {
      applySettings(dcSettings || {});
      reRenderAllTitles();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.dcSettings) {
        applySettings(changes.dcSettings.newValue || {});
        reRenderAllTitles();   // titles need a JS swap; thumbnails + Shorts are pure CSS
      }
    });
  } catch (e) { /* storage unavailable → keep defaults */ }
}

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

// ── Thumbnail swap (HIT) ───────────────────────────────────────────────────────
// We do NOT mutate YouTube's own <img>.src — its yt-core-image component owns that
// element and resets src on render/scroll. Instead we OVERLAY our own <img> on top.
// YouTube's render loop never touches an element it doesn't manage, so the overlay
// sticks. We flip the card to data-dc-thumb="hit" only on the overlay's `load` event,
// so the loading cover stays up until our frame is actually painted — no half-loaded
// flash, no clean→clean pop.

function showThumbHit(card, thumbImg, thumbUrl) {
  if (!thumbImg) { console.log(`[DC] showThumbHit: NO <img> element for ${thumbUrl}`); return; }
  const host = thumbImg.parentElement;
  if (!host) { console.log(`[DC] showThumbHit: <img> has no parent for ${thumbUrl}`); return; }

  let overlay = host.querySelector(":scope > img.dc-thumb-overlay");
  if (overlay && overlay.dataset.dcThumb === thumbUrl && card.dataset.dcThumb === "hit") return;

  if (!overlay) {
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    overlay = document.createElement("img");
    overlay.className = "dc-thumb-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;pointer-events:none;";
    host.appendChild(overlay);
  }
  overlay.dataset.dcThumb = thumbUrl;
  // Reveal only once the frame has actually decoded (covers the load gap cleanly).
  overlay.onload = () => {
    card.dataset.dcThumb = "hit";
    console.log(`[DC] thumb hit revealed -> ${thumbUrl}`);
  };
  // If our frame can't load (broken/expired CDN object), don't leave the card stuck on
  // the loading cover — reveal the original so it's never permanently masked.
  overlay.onerror = () => {
    overlay.remove();
    if (card.dataset.dcThumb !== "hit") card.dataset.dcThumb = "orig";
    console.log(`[DC] thumb overlay failed to load -> ${thumbUrl} (revealing original)`);
  };
  overlay.src = thumbUrl;
  thumbImg.dataset.dcThumb = thumbUrl;
  // If it was already cached/complete, onload may not fire — reveal immediately.
  if (overlay.complete && overlay.naturalWidth > 0) card.dataset.dcThumb = "hit";
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

// ── Core: lifecycle, request, and apply ────────────────────────────────────────
// Title and thumbnail resolve INDEPENDENTLY and may arrive on different ticks (the
// thumbnail worker is separate + slower), so each card is curable until BOTH land or it
// ages out. Timings are WALL-CLOCK from first-seen (deterministic regardless of how many
// ticks fire):
//
//   TITLE_RELEASE_MS — the title shows a shimmer skeleton until here (short); then, if no
//     rewrite has arrived, we reveal the ORIGINAL so it's readable fast (and keep curing —
//     a later rewrite still upgrades it). A *rewrite* is the only terminal title state.
//   CURE_MS — terminal. The thumbnail keeps its loading SHIMMER (and keeps polling) the
//     whole cure window; only here, if still no frame, does it switch to the black
//     hover-fade miss. A *frame* is the only terminal thumb state. (Longer than the title
//     window on purpose — titles come in quick; thumbnails shimmer + poll for longer.)

const TITLE_RELEASE_MS = 2500;    // reveal original title fast if no rewrite yet (still upgrades to rewrite when it lands)
const CURE_MS          = 45000;   // thumb keeps shimmering + polling this long before giving up to black
const FETCH_TIMEOUT_MS = 8000;    // bound each request so a hang can't stall the lane

// Resolve one card against a /titles result (or {} on miss/error). Returns true if the
// card is still pending (not terminal) — used to decide whether to keep the cure lane alive.
function resolveCard(card, info, result) {
  const original = card.dataset.dcOrig ?? info.originalTitle;
  const age = Date.now() - Number(card.dataset.dcSeen || Date.now());

  // THUMB — overlay our frame whenever the server has one. The card flips to
  // data-dc-thumb="hit" on the overlay's load event (so the cover holds until painted).
  if (result.thumbUrl) showThumbHit(card, info.thumbImg, result.thumbUrl);

  // TITLE — a rewrite is terminal + reveals immediately; otherwise reveal the original
  // once we've waited TITLE_RELEASE_MS (still curable for a later rewrite).
  const titleHit = result.status === "hit" && !!result.rewrittenTitle;
  if (titleHit) {
    card.dataset.dcRewritten = result.rewrittenTitle;   // store for instant on/off flip
    displayCardTitle(card, info);                        // rewrite if titles ON, else original
    card.dataset.dcTitle = "";   // reveal
  } else if (card.dataset.dcTitle === undefined && age >= TITLE_RELEASE_MS) {
    card.dataset.dcTitle = "";   // reveal original; keep curing
  }

  // Terminal when BOTH are truly in, or when we've exhausted the cure window.
  if (titleHit && result.thumbUrl) {
    card.dataset.dc = "done";
    return false;
  }
  if (age >= CURE_MS) {
    card.dataset.dc = "done";
    if (card.dataset.dcTitle === undefined) card.dataset.dcTitle = "";          // keep original
    if (!result.thumbUrl && card.dataset.dcThumb !== "hit") card.dataset.dcThumb = "miss"; // black
    return false;
  }
  card.dataset.dc = "pending";
  return true;
}

// Batch-request /titles for the given cards and apply results. Stashes the true original
// title + first-seen timestamp on first contact. Drives the cure lane while work remains.
async function requestAndApply(cards) {
  const entries = cards.map(card => ({ card, info: getCardInfo(card) }));
  // A card with no recognizable info isn't one we mask — release it fully so the gate
  // (which only keys on our attrs) never traps a non-video element.
  entries.forEach(({ card, info }) => {
    if (!info) { card.dataset.dc = "skip"; card.dataset.dcTitle = ""; card.dataset.dcThumb = "orig"; }
  });

  const valid = entries.filter(({ info }) => info !== null);
  if (!valid.length) return;

  for (const { card, info } of valid) {
    if (!card.dataset.dcOrig) {
      card.dataset.dcOrig = info.originalTitle;
      card.dataset.dcSeen = String(Date.now());
    }
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

  let results = null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${API_BASE}/titles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(to));
    if (resp.ok) {
      ({ results } = await resp.json());
      const ids = Object.keys(results ?? {});
      console.log(`[DC] /titles → ${ids.length} results | hits=${ids.filter(id => results[id].status === "hit").length} | withThumb=${ids.filter(id => results[id].thumbUrl).length}`);
    } else {
      console.log(`[DC] /titles HTTP ${resp.status} — will retry via cure lane`);
    }
  } catch (e) {
    console.log(`[DC] /titles request failed (${e.name}) — will retry via cure lane`);
  }

  // Apply (results===null on error → every card resolves against {} = a transient miss:
  // it stays pending and the cure lane retries, and the CURE_MS deadline still releases it).
  let anyPending = false;
  for (const { card, info } of valid) {
    const result = (results && results[info.videoId]) || {};
    if (resolveCard(card, info, result)) anyPending = true;
  }
  if (anyPending) ensureCureLane();
}

// ── P1: two-lane scheduling (discover + cure) ──────────────────────────────────
// DISCOVER (event-driven): process cards we've never seen. Fired by the MutationObserver
//   + initial + SPA-nav, so every newly-inserted card (initial feed, infinite scroll,
//   "Show more") is masked and requested the instant it appears — never re-queries an
//   already-seen card, so scroll churn doesn't multiply API calls.
// CURE (timer-driven): re-query cards that are seen-but-unresolved, on a gentle interval,
//   only while such cards exist (self-stops when none). This is the bounded polling that
//   upgrades a miss to the real frame/rewrite as the worker catches up — one batched,
//   read-only request per tick (the resolver's re-enqueue cooldown protects the queue).

const needsDiscovery = card => !card.dataset.dcSeen && card.dataset.dc !== "skip";
const needsCure      = card => card.dataset.dcSeen && card.dataset.dc !== "done" && card.dataset.dc !== "skip";

function collectAndApply(predicate) {
  const cards = [...document.querySelectorAll(CARD_SELECTOR)].filter(predicate);
  if (cards.length) requestAndApply(cards);
}

const discover = () => collectAndApply(needsDiscovery);

const CURE_INTERVAL_MS = 2000;   // poll cadence for cured titles/thumbs; per-card CURE_MS caps it
let cureTimer = null;
function ensureCureLane() {
  if (cureTimer) return;
  cureTimer = setTimeout(() => {
    cureTimer = null;
    collectAndApply(needsCure);   // resolveCard re-arms the lane if anything is still pending
  }, CURE_INTERVAL_MS);
}

// ── Watch-page title (QOL) ─────────────────────────────────────────────────────
// On a /watch page, show OUR cleaned title for the video being viewed; hovering the
// title reveals the original. Client-only, reuses /titles. Separate from the card path
// (the watch title is `ytd-watch-metadata h1 yt-formatted-string`, not a card). We only
// ever overwrite the VISIBLE text (textContent) and leave YouTube's `title` attribute as
// the real original — so we can always read the true original back (and hover restores it).

const watchTitleCache = {};    // videoId -> { rewritten }
const watchAttempts   = {};    // videoId -> fetch count (bounds polling for a persistent miss)
const WATCH_MAX_ATTEMPTS = 8;
const WATCH_MIN_REFETCH_MS = 3000;

function getWatchVideoId() {
  if (location.pathname !== "/watch") return null;
  try { return new URL(location.href).searchParams.get("v"); } catch { return null; }
}

const watchTitleEl = () => document.querySelector("ytd-watch-metadata h1 yt-formatted-string");

// The hover target + height lock live on the <h1> container (stable across renders), NOT on
// the text element — because our cleaned title is often TALLER than the original, so swapping
// to the shorter original on hover would shrink the box out from under the cursor and flicker.
const watchContainer = el => el.closest("h1") || el.parentElement || el;

function lockWatchHeight(el) {
  const c = watchContainer(el);
  c.style.minHeight = "";                        // let it size to the current (cleaned) title…
  c.style.minHeight = c.offsetHeight + "px";     // …then pin that height so a shorter hover-title can't shrink it
}

function bindWatchHover(el) {
  const c = watchContainer(el);
  if (c.dataset.dcWatchBound === "1") return;
  c.dataset.dcWatchBound = "1";
  c.style.cursor = "help";
  // Listeners on the container; look the text element up live (survives YT re-renders).
  c.addEventListener("mouseenter", () => {
    c.dataset.dcWatchHover = "1";
    const cel = watchTitleEl();
    const orig = cel && cel.getAttribute("title");   // YouTube keeps this = the real original
    if (cel && orig) cel.textContent = orig;
  });
  c.addEventListener("mouseleave", () => {
    c.dataset.dcWatchHover = "0";
    const cel = watchTitleEl();
    if (!cel || !titlesOn()) return;                       // titles off → original already shown, leave it
    const e = watchTitleCache[getWatchVideoId()];
    if (e) cel.textContent = e.rewritten;
  });
}

function applyWatchTitle(el, videoId) {
  const e = watchTitleCache[videoId];
  if (!e) return;
  el.dataset.dcWatch = videoId;
  bindWatchHover(el);
  if (watchContainer(el).dataset.dcWatchHover !== "1") {   // don't clobber a hover-peek
    // Titles ON → our cleaned title; OFF → YouTube's original (kept in the title attr).
    el.textContent = titlesOn() ? e.rewritten : (el.getAttribute("title") || e.rewritten);
    lockWatchHeight(el);                                   // reserve the height → no snap-back on hover
  }
}

// Re-apply the watch title on a settings flip (respecting titles ON/OFF).
function reRenderWatchTitle() {
  const vid = getWatchVideoId();
  const el = watchTitleEl();
  if (vid && el && watchTitleCache[vid]) applyWatchTitle(el, vid);
}

async function processWatchTitle() {
  const videoId = getWatchVideoId();
  if (!videoId) return;
  const el = watchTitleEl();
  if (!el) return;

  // Already have it → (re)assert the cleaned title (cheap; re-applies if YouTube re-rendered).
  if (watchTitleCache[videoId]) { applyWatchTitle(el, videoId); return; }

  // Throttle re-fetches (the observer fires a lot on a busy watch page) + bound total tries.
  const now = Date.now();
  if (el.dataset.dcWatchPending === videoId) return;
  if (now - Number(el.dataset.dcWatchLast || 0) < WATCH_MIN_REFETCH_MS) return;
  if ((watchAttempts[videoId] || 0) >= WATCH_MAX_ATTEMPTS) return;

  const original = (el.getAttribute("title") || el.textContent || "").trim();
  if (!original) return;
  const creator = document.querySelector(
    "ytd-video-owner-renderer ytd-channel-name a, ytd-channel-name#channel-name a"
  )?.textContent?.trim() || "";

  el.dataset.dcWatchPending = videoId;
  el.dataset.dcWatchLast = String(now);
  watchAttempts[videoId] = (watchAttempts[videoId] || 0) + 1;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(`${API_BASE}/titles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: [{ videoId, title: original, creator }] }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(to));
    el.dataset.dcWatchPending = "";
    if (!resp.ok) return;
    const { results } = await resp.json();
    const r = results?.[videoId];
    if (r && r.status === "hit" && r.rewrittenTitle) {
      watchTitleCache[videoId] = { rewritten: r.rewrittenTitle };
      applyWatchTitle(el, videoId);
      console.log(`[DC] watch title → ${JSON.stringify(r.rewrittenTitle)}`);
    }
    // miss → leave YouTube's original; scheduled polls retry until cured or capped
  } catch (e) {
    el.dataset.dcWatchPending = "";
  }
}

const WATCH_OFFSETS_MS = [0, 1500, 4000, 9000, 18000];   // catch-up polls after each load/nav
let watchTimers = [];
function scheduleWatchTitle() {
  watchTimers.forEach(clearTimeout);
  watchTimers = WATCH_OFFSETS_MS.map(ms => setTimeout(processWatchTitle, ms));
}

// ── Bootstrap + MutationObserver + SPA navigation ──────────────────────────────
// run_at is document_start now, so inject the gate before YouTube paints, then watch
// for cards. Observe documentElement (body may not exist yet at document_start).

injectGateCss();
loadSettings();   // set root toggle attributes (defaults ON) + live-update on popup changes

let debounceTimer;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { discover(); processWatchTitle(); }, 300);
});

observer.observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener("yt-navigate-finish", () => {
  clearTimeout(debounceTimer);
  discover();
  scheduleWatchTitle();   // new video → cleaned title + hover-to-see-original
});

discover();
scheduleWatchTitle();
