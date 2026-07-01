// De-Clickbait popup — three toggles persisted to chrome.storage.local.
// The content script reads the same `dcSettings` object + reacts to changes live.
// Defaults: everything ON (titles + thumbnails replaced, Shorts hidden).

const DEFAULTS = { titles: true, thumbs: true, hideShorts: true };
const KEYS = ["titles", "thumbs", "hideShorts"];

function load() {
  chrome.storage.local.get("dcSettings", ({ dcSettings }) => {
    const s = { ...DEFAULTS, ...(dcSettings || {}) };
    for (const k of KEYS) document.getElementById(k).checked = !!s[k];
  });
}

function save() {
  const s = {};
  for (const k of KEYS) s[k] = document.getElementById(k).checked;
  chrome.storage.local.set({ dcSettings: s });
}

for (const k of KEYS) {
  document.getElementById(k).addEventListener("change", save);
}
load();
