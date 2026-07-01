// Face Value popup.
// Persists `dcSettings` = { titles, thumbs, hideShorts, channels[] } to chrome.storage.local.
// The content script reads the same object and reacts live (no page reload):
//   - titles/thumbs/hideShorts flip the feed instantly
//   - channels[] is the "Channel Exceptions" pause list (case-insensitive channel names)
// It also reads `dcStats.titlesFixed` for the counter (a local, approximate tally the
// content script increments as it cleans titles).

const TOGGLES = ["titles", "thumbs", "hideShorts"];
const DEFAULTS = { titles: true, thumbs: true, hideShorts: true, channels: [] };

// TODO: point this at the real donation link before launch.
const DONATE_URL = "https://github.com/sponsors";

// Deterministic chip color from a channel name (calm, desaturated palette from the design).
const PALETTE = ["#3a6ea5", "#c26b2d", "#4a8a4a", "#a03a3a", "#c99a2e", "#5a5aa0", "#2f8f8f", "#8a4a8a"];
function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

let state = { ...DEFAULTS };

function render() {
  // toggle rows
  for (const key of TOGGLES) {
    const row = document.querySelector(`.row[data-key="${key}"]`);
    row.classList.toggle("on", !!state[key]);
    row.setAttribute("aria-checked", state[key] ? "true" : "false");
  }
  // master = on if anything is on
  const anyOn = TOGGLES.some(k => state[k]);
  const master = document.getElementById("master");
  master.classList.toggle("on", anyOn);
  document.getElementById("master-lbl").textContent = anyOn ? "On" : "Off";

  // channel chips
  const chips = document.getElementById("chips");
  chips.innerHTML = "";
  for (const name of state.channels) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const ini = document.createElement("div");
    ini.className = "ini";
    ini.style.background = colorFor(name.toLowerCase());
    ini.textContent = (name[0] || "?").toUpperCase();
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = name;
    const x = document.createElement("div");
    x.className = "x";
    x.textContent = "×";
    x.title = "Resume Face Value on this channel";
    x.addEventListener("click", () => removeChannel(name));
    chip.append(ini, nm, x);
    chips.appendChild(chip);
  }
  document.getElementById("chan-count").textContent =
    `${state.channels.length} paused`;
}

function save() {
  chrome.storage.local.set({ dcSettings: state });
}

function setToggle(key) {
  state[key] = !state[key];
  render();
  save();
}

function setMaster() {
  const anyOn = TOGGLES.some(k => state[k]);
  const next = !anyOn;                       // all-off → all-on, otherwise all-off
  for (const k of TOGGLES) state[k] = next;
  render();
  save();
}

function addChannel(raw) {
  const name = (raw || "").trim();
  if (!name) return;
  if (state.channels.some(c => c.toLowerCase() === name.toLowerCase())) return;  // dedupe
  state.channels = [...state.channels, name];
  render();
  save();
}

function removeChannel(name) {
  state.channels = state.channels.filter(c => c.toLowerCase() !== name.toLowerCase());
  render();
  save();
}

function load() {
  chrome.storage.local.get(["dcSettings", "dcStats"], ({ dcSettings, dcStats }) => {
    state = { ...DEFAULTS, ...(dcSettings || {}) };
    if (!Array.isArray(state.channels)) state.channels = [];
    render();
    const n = (dcStats && dcStats.titlesFixed) || 0;
    document.getElementById("stat").textContent = n.toLocaleString();
  });
}

// ── wiring ──────────────────────────────────────────────────────────────────────
for (const key of TOGGLES) {
  const row = document.querySelector(`.row[data-key="${key}"]`);
  row.addEventListener("click", () => setToggle(key));
  row.addEventListener("keydown", e => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); setToggle(key); }
  });
}

const master = document.getElementById("master");
master.addEventListener("click", setMaster);
master.addEventListener("keydown", e => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); setMaster(); }
});

const input = document.getElementById("chan-input");
input.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); addChannel(input.value); input.value = ""; }
});

const donate = document.getElementById("donate");
donate.href = DONATE_URL;

load();
