#!/usr/bin/env node
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

function findSettingsPath() {
  const pkg = "Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json";
  // Native Windows
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Packages", pkg);
  }
  // WSL — detect Windows user from /mnt/c/Users
  try {
    const users = fs.readdirSync("/mnt/c/Users").filter((u) =>
      !["Default", "Public", "Default User", "All Users"].includes(u) &&
      fs.existsSync(path.join("/mnt/c/Users", u, "AppData/Local/Packages", pkg))
    );
    if (users.length > 0) return path.join("/mnt/c/Users", users[0], "AppData/Local/Packages", pkg);
  } catch {}
  console.error("Could not find Windows Terminal settings.json. Set TERMINAL_SETTINGS_PATH env var.");
  process.exit(1);
}

const SETTINGS_PATH = process.env.TERMINAL_SETTINGS_PATH || findSettingsPath();
const DATA_DIR = path.join(os.homedir(), ".terminalizer");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const FAVORITES_PATH = path.join(DATA_DIR, "favorites.json");
const CACHE_PATH = path.join(DATA_DIR, "themes-cache.json");
const BACKUP_PATH = path.join(DATA_DIR, "settings.backup.json");
const PORT = process.env.PORT || 3456;
// Bind to loopback only — this API mutates your Windows Terminal config with no auth,
// so it must not be reachable from the local network. Override with HOST=0.0.0.0 at your own risk.
const HOST = process.env.HOST || "127.0.0.1";

// --- Favorites ---
function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_PATH, "utf-8")); }
  catch { return []; }
}
function saveFavorites(favs) {
  fs.writeFileSync(FAVORITES_PATH, JSON.stringify(favs, null, 2), "utf-8");
}

// --- Settings ---
// Windows Terminal's settings.json is JSONC: it can contain // and /* */ comments
// and trailing commas. Strip those (without touching string contents) before parsing.
function parseJsonc(text) {
  text = text.replace(/^﻿/, ""); // strip BOM
  let out = "", inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas
  return JSON.parse(out);
}

function readSettings() {
  return parseJsonc(fs.readFileSync(SETTINGS_PATH, "utf-8"));
}

function writeSettings(settings) {
  // Back up the user's original config once, before we ever touch it.
  try {
    if (!fs.existsSync(BACKUP_PATH) && fs.existsSync(SETTINGS_PATH)) {
      fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    }
  } catch {}
  // Atomic write: write to a temp file in the same dir, then rename over the target,
  // so a crash mid-write can never leave a corrupted settings.json.
  const tmp = SETTINGS_PATH + ".terminalizer.tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 4), "utf-8");
  fs.renameSync(tmp, SETTINGS_PATH);
}
function getCurrentScheme(settings) {
  return settings.profiles.defaults.colorScheme || "Tokyo Night";
}
function getFont(settings) {
  return settings.profiles.defaults.font || { face: "JetBrainsMono Nerd Font", size: 13, weight: "normal" };
}

// Standard Windows Terminal color-scheme keys (16 ANSI + surfaces). Used to slim schemes
// down to just what the UI needs (full palette for the preview strip, swatches, etc.).
const SCHEME_KEYS = [
  "background", "foreground", "cursorColor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightPurple", "brightCyan", "brightWhite",
];
function slimScheme(s) {
  const o = { name: s.name };
  for (const k of SCHEME_KEYS) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

// --- External themes ---
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "TerminalRandomizer/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }).on("error", reject);
  });
}

async function fetchExternalIndex() {
  // Check cache (24h)
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    if (Date.now() - cache.timestamp < 86400000) return cache.themes;
  } catch {}

  const res = await httpsGet("https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/windowsterminal");
  if (res.status !== 200) return [];
  const files = JSON.parse(res.data);
  const themes = files.map((f) => ({
    name: f.name.replace(".json", ""),
    download_url: f.download_url,
  }));
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), themes }), "utf-8");
  return themes;
}

async function fetchExternalTheme(url) {
  const res = await httpsGet(url);
  if (res.status !== 200) return null;
  return JSON.parse(res.data);
}

// --- Auto-shuffle ---
let shuffleInterval = null;
let shuffleMs = 0;
let shuffleFavsOnly = false;

function startShuffle(ms, favsOnly = false) {
  stopShuffle();
  shuffleMs = ms;
  shuffleFavsOnly = favsOnly;
  shuffleInterval = setInterval(() => {
    const settings = readSettings();
    const current = getCurrentScheme(settings);
    let pool;
    if (shuffleFavsOnly) {
      const favs = loadFavorites();
      pool = favs.filter((n) => n !== current && settings.schemes.some((s) => s.name === n));
    } else {
      pool = settings.schemes.map((s) => s.name).filter((n) => n !== current);
    }
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    settings.profiles.defaults.colorScheme = pick;
    writeSettings(settings);
  }, ms);
}

function stopShuffle() {
  if (shuffleInterval) clearInterval(shuffleInterval);
  shuffleInterval = null;
  shuffleMs = 0;
}

// --- Parse JSON body ---
function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); } // malformed body -> empty object, never hang the request
    });
  });
}

// Only fetch installable themes from the known upstream host (blocks SSRF via a crafted url).
function isAllowedThemeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" && parsed.hostname === "raw.githubusercontent.com";
  } catch { return false; }
}

// CSRF guard: a browser sets Origin (or at least Referer) on cross-site requests. Reject any
// POST whose Origin/Referer isn't this local server. Requests with neither header (e.g. curl)
// can't be driven by a malicious page, so they're allowed.
function originAllowed(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true;
  try {
    const h = new URL(src).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  } catch { return false; }
}

// --- HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Terminalizer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d0d1a; --surface: #15152a; --surface-2: #111120; --surface-3: #1a1a32;
      --accent-bg: #1c1c38; --accent-count: #1e2550;
      --border: #2a2a4a; --border-strong: #3a3a6a; --border-soft: #1e1e35; --border-faint: #1a1a30;
      --text: #e0e0e0; --text-strong: #ffffff; --text-dim: #9a9ab0; --text-mid: #cccccc;
      --text-faint: #4a4a65; --text-ghost: #555555; --placeholder: #3a3a55;
      --accent: #7aa2f7; --accent-2: #bb9af7; --accent-soft: #c0caf5;
      --card-border: rgba(255,255,255,0.06); --card-border-hover: rgba(255,255,255,0.12);
      --shadow: rgba(0,0,0,0.3); --shadow-strong: rgba(0,0,0,0.35);
    }
    :root[data-ui-theme="light"] {
      --bg: #eceef6; --surface: #ffffff; --surface-2: #f5f6fb; --surface-3: #e9ebf6;
      --accent-bg: #e7ecfc; --accent-count: #dde6ff;
      --border: #d4d8e8; --border-strong: #bcc2d8; --border-soft: #e3e6f1; --border-faint: #e7e9f3;
      --text: #2c2e3e; --text-strong: #14151f; --text-dim: #5b5e74; --text-mid: #44475a;
      --text-faint: #8b8fa6; --text-ghost: #9a9eb4; --placeholder: #a8acc0;
      --accent: #4f74d8; --accent-2: #8c63d8; --accent-soft: #45599e;
      --card-border: rgba(0,0,0,0.08); --card-border-hover: rgba(0,0,0,0.16);
      --shadow: rgba(40,44,80,0.12); --shadow-strong: rgba(40,44,80,0.18);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      font-family: 'Inter', -apple-system, system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: background 0.3s ease, color 0.3s ease;
    }
    .app {
      max-width: 900px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 4rem;
    }
    header {
      text-align: center;
      margin-bottom: 2.5rem;
      position: relative;
    }
    h1 {
      font-size: 1.6rem; color: var(--text-strong); margin-bottom: 0.35rem;
      font-weight: 700; letter-spacing: -0.02em;
    }
    .subtitle { font-size: 0.82rem; color: var(--text-ghost); font-weight: 400; letter-spacing: 0.01em; }

    /* UI light/dark toggle */
    .ui-toggle {
      position: absolute; right: 0; top: 0;
      background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
      width: 34px; height: 34px; border-radius: 10px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 0.95rem;
      transition: all 0.2s ease;
    }
    .ui-toggle:hover { border-color: var(--accent); color: var(--text); }

    /* Terminal Preview */
    .terminal-preview {
      border-radius: 14px;
      overflow: hidden;
      margin-bottom: 1.75rem;
      border: 1px solid var(--border);
      font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      transition: background 0.35s ease, border-color 0.2s ease;
      box-shadow: 0 8px 32px var(--shadow);
    }
    .terminal-titlebar {
      padding: 0.6rem 1rem;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .terminal-dot {
      width: 11px; height: 11px; border-radius: 50%;
      box-shadow: inset 0 -1px 2px rgba(0,0,0,0.2);
    }
    .terminal-titlebar span {
      margin-left: auto; font-size: 0.68rem; opacity: 0.4;
      font-family: 'Inter', system-ui, sans-serif; font-weight: 500;
    }
    .terminal-body { padding: 1rem 1.3rem; }
    .terminal-body .line { white-space: pre; }

    /* 16-color ANSI palette strip */
    .palette-strip { display: flex; flex-direction: column; gap: 3px; padding: 0 1.3rem 1rem; }
    .palette-row { display: flex; gap: 3px; }
    .palette-row .pc {
      flex: 1; height: 12px; border-radius: 3px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
    }

    /* Controls row */
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.75rem;
      flex-wrap: wrap;
    }
    .btn {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0.6rem 1.4rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: 0.01em;
      user-select: none;
    }
    .btn:active { transform: scale(0.97); }
    .btn[disabled] { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #1a1b26;
      border: none;
      box-shadow: 0 2px 8px rgba(122,162,247,0.2);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(122,162,247,0.3);
      filter: brightness(1.05);
    }
    .btn-primary:active { transform: translateY(0) scale(0.97); }
    .btn-secondary {
      background: var(--surface);
      color: var(--text-dim);
    }
    .btn-secondary:hover { border-color: var(--accent); color: var(--text); background: var(--surface-3); }
    .btn-secondary.active {
      border-color: var(--accent-2);
      color: var(--accent-2);
      background: var(--accent-bg);
      box-shadow: 0 0 12px rgba(187,154,247,0.15);
    }

    /* Font size */
    .font-controls {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-left: auto;
    }
    .font-controls label {
      font-size: 0.65rem; color: var(--text-faint); text-transform: uppercase;
      letter-spacing: 0.1em; font-weight: 600; margin-right: 2px;
    }
    .size-btn {
      background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.9rem; font-weight: 500; transition: all 0.2s ease;
      font-family: 'Inter', system-ui, sans-serif;
    }
    .size-btn:hover { border-color: var(--accent); color: var(--text-strong); background: var(--surface-3); }
    .size-btn:active { transform: scale(0.92); }
    .size-display {
      font-size: 0.8rem; color: var(--text); min-width: 24px; text-align: center;
      font-weight: 600; font-variant-numeric: tabular-nums;
    }

    /* Shuffle controls */
    .shuffle-row {
      display: flex; align-items: center; gap: 8px;
    }
    .shuffle-select {
      background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
      padding: 0.45rem 0.65rem; border-radius: 10px; font-size: 0.78rem;
      font-family: 'Inter', system-ui, sans-serif; cursor: pointer;
      font-weight: 500; transition: all 0.2s ease;
    }
    .shuffle-select:hover { border-color: var(--border-strong); color: var(--text-mid); }
    .shuffle-select:focus { outline: none; border-color: var(--accent); }

    /* Opacity slider */
    .slider-row {
      display: flex; align-items: center; gap: 10px;
      background: var(--surface-2); border: 1px solid var(--border-soft);
      border-radius: 12px; padding: 0.6rem 1.1rem;
      margin-bottom: 1.75rem;
    }
    .slider-row label {
      font-size: 0.65rem; color: var(--text-faint); text-transform: uppercase;
      letter-spacing: 0.1em; flex-shrink: 0; font-weight: 600;
    }
    .slider-row input[type=range] {
      flex: 1; -webkit-appearance: none; appearance: none;
      height: 4px; background: var(--border); border-radius: 2px; outline: none;
    }
    .slider-row input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 16px; height: 16px;
      border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2));
      cursor: pointer; border: 2px solid var(--bg);
      box-shadow: 0 0 8px rgba(122,162,247,0.3);
    }
    .slider-row .slider-value {
      font-size: 0.78rem; color: var(--accent-soft); min-width: 36px; text-align: right;
      font-weight: 600; font-variant-numeric: tabular-nums;
    }

    /* Tabs */
    .tabs {
      display: flex; gap: 2px; margin-bottom: 1.1rem;
      border-bottom: 1px solid var(--border-faint);
      padding-bottom: 0;
    }
    .tab {
      background: none; border: none; color: var(--text-faint); padding: 0.65rem 1.1rem;
      font-size: 0.78rem; cursor: pointer; font-family: 'Inter', system-ui, sans-serif;
      font-weight: 500; border-bottom: 2px solid transparent; transition: all 0.2s ease;
    }
    .tab:hover { color: var(--text-dim); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .tab .count {
      background: var(--border-faint); color: var(--text-ghost); font-size: 0.6rem;
      padding: 2px 7px; border-radius: 10px; margin-left: 6px;
      font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .tab.active .count { background: var(--accent-count); color: var(--accent); }

    /* Search + filters */
    .search-row {
      display: flex; gap: 8px; align-items: center; margin-bottom: 1rem;
    }
    .search-bar {
      flex: 1;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.6rem 1rem;
      border-radius: 12px;
      font-size: 0.82rem;
      font-family: 'Inter', system-ui, sans-serif;
      font-weight: 400;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    .search-bar:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(122,162,247,0.1);
    }
    .search-bar::placeholder { color: var(--placeholder); }
    .filter-pills { display: flex; gap: 4px; flex-shrink: 0; }
    .filter-pill {
      background: var(--surface); border: 1px solid var(--border); color: var(--text-faint);
      padding: 0.45rem 0.8rem; border-radius: 10px; font-size: 0.72rem;
      cursor: pointer; font-family: 'Inter', system-ui, sans-serif;
      font-weight: 600; transition: all 0.2s ease; letter-spacing: 0.02em;
    }
    .filter-pill:hover { color: var(--text-dim); border-color: var(--border-strong); }
    .filter-pill.active { background: var(--accent-bg); color: var(--accent-soft); border-color: var(--accent); }

    /* Scheme grid */
    .scheme-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 8px;
      max-height: 55vh;
      overflow-y: auto;
      padding-right: 4px;
    }
    .scheme-grid::-webkit-scrollbar { width: 5px; }
    .scheme-grid::-webkit-scrollbar-track { background: transparent; }
    .scheme-grid::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

    .scheme-card {
      border: 2px solid var(--card-border);
      border-radius: 12px;
      padding: 0.6rem 0.85rem;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 10px;
      position: relative;
    }
    .scheme-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px var(--shadow-strong);
      border-color: var(--card-border-hover);
    }
    .scheme-card.active {
      border-color: var(--accent);
      box-shadow: 0 0 20px rgba(122,162,247,0.3), inset 0 0 24px rgba(122,162,247,0.06);
    }
    .scheme-card .active-badge {
      display: none;
      position: absolute;
      top: -7px; right: -7px;
      background: linear-gradient(135deg, #7aa2f7, #bb9af7);
      color: #1a1b26;
      width: 20px; height: 20px;
      border-radius: 50%;
      font-size: 0.6rem;
      line-height: 20px;
      text-align: center;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(122,162,247,0.4);
    }
    .scheme-card.active .active-badge { display: block; }

    .scheme-colors {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; flex-shrink: 0;
    }
    .scheme-colors .c {
      width: 11px; height: 11px; border-radius: 3px;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15);
    }
    .scheme-name {
      font-size: 0.76rem; flex: 1; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      letter-spacing: 0.01em;
    }

    .fav-btn {
      background: none; border: none; cursor: pointer;
      font-size: 1rem; padding: 2px; transition: all 0.2s ease;
      flex-shrink: 0; color: #555; line-height: 1;
    }
    .fav-btn:hover { transform: scale(1.25); color: #f0c040; }
    .fav-btn.favorited { color: #f0c040; text-shadow: 0 0 10px rgba(240,192,64,0.5); }

    .install-btn {
      background: rgba(122,162,247,0.1); border: 1px solid rgba(122,162,247,0.25); color: #7aa2f7;
      font-size: 0.68rem; padding: 4px 10px; border-radius: 8px;
      cursor: pointer; flex-shrink: 0; font-family: 'Inter', system-ui, sans-serif;
      font-weight: 600; transition: all 0.2s ease;
    }
    .install-btn:hover { background: rgba(122,162,247,0.2); border-color: #7aa2f7; }

    /* Loading */
    .loading { text-align: center; padding: 2rem; color: var(--text-ghost); font-size: 0.85rem; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Toast */
    .toast {
      position: fixed; bottom: 2rem; left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #1a1b26;
      padding: 0.6rem 1.6rem; border-radius: 12px;
      font-weight: 600; font-size: 0.78rem;
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: 0.01em;
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none; z-index: 100;
      box-shadow: 0 8px 24px rgba(122,162,247,0.3);
    }
    .toast.show { transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>
<div class="app">
  <header>
    <button class="ui-toggle" id="ui-toggle" onclick="toggleUiTheme()" title="Toggle light / dark UI">&#9789;</button>
    <h1>The Terminalizer</h1>
    <p class="subtitle">Randomize, preview, and hot-swap your Windows Terminal themes</p>
  </header>

  <!-- Terminal Preview -->
  <div class="terminal-preview" id="terminal-preview">
    <div class="terminal-titlebar" id="tp-titlebar">
      <div class="terminal-dot" style="background:#ff5f57"></div>
      <div class="terminal-dot" style="background:#ffbd2e"></div>
      <div class="terminal-dot" style="background:#28c840"></div>
      <span id="tp-name">Loading...</span>
    </div>
    <div class="terminal-body" id="tp-body"></div>
    <div class="palette-strip" id="tp-palette"></div>
  </div>

  <!-- Controls -->
  <div class="controls">
    <button class="btn btn-primary" onclick="randomize()" title="Switch to a random installed theme (Space)">Randomize</button>
    <button class="btn btn-secondary" id="randfav-btn" onclick="randomFav()" title="Switch to a random favorite">&#9733; Random fav</button>
    <button class="btn btn-secondary" id="surprise-btn" onclick="surprise()" title="Install &amp; apply a random theme from all 515+">&#127922; Surprise me</button>
    <button class="btn btn-secondary" id="undo-btn" onclick="undoTheme()" style="display:none" title="Undo (U)">&#8634; Undo</button>
    <button class="btn btn-secondary" id="redo-btn" onclick="redoTheme()" style="display:none" title="Redo (R)">&#8635; Redo</button>
    <div class="shuffle-row">
      <button class="btn btn-secondary" id="shuffle-btn" onclick="toggleShuffle()">Auto-shuffle</button>
      <select class="shuffle-select" id="shuffle-interval" onchange="updateShuffle()">
        <option value="30000">30s</option>
        <option value="60000" selected>1m</option>
        <option value="300000">5m</option>
        <option value="600000">10m</option>
        <option value="1800000">30m</option>
      </select>
      <button class="btn btn-secondary" id="favs-only-btn" onclick="toggleFavsOnly()">Favs only</button>
    </div>
    <div class="font-controls">
      <label>Size</label>
      <button class="size-btn" onclick="changeSize(-1)">-</button>
      <span class="size-display" id="font-size">13</span>
      <button class="size-btn" onclick="changeSize(1)">+</button>
    </div>
  </div>

  <!-- Opacity -->
  <div class="slider-row">
    <label>Opacity</label>
    <input type="range" id="opacity-slider" min="30" max="100" value="95" oninput="updateOpacity(this.value)">
    <span class="slider-value" id="opacity-value">95%</span>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" data-tab="installed" onclick="switchTab('installed')">
      Installed <span class="count" id="installed-count">0</span>
    </button>
    <button class="tab" data-tab="favorites" onclick="switchTab('favorites')">
      Favorites <span class="count" id="favorites-count">0</span>
    </button>
    <button class="tab" data-tab="explore" onclick="switchTab('explore')">
      Explore <span class="count" id="explore-count">515</span>
    </button>
  </div>

  <div class="search-row">
    <input class="search-bar" id="search" placeholder="Search themes..." oninput="renderGrid()">
    <div class="filter-pills">
      <button class="filter-pill active" data-filter="all" onclick="setFilter('all')">All</button>
      <button class="filter-pill" data-filter="dark" onclick="setFilter('dark')">Dark</button>
      <button class="filter-pill" data-filter="light" onclick="setFilter('light')">Light</button>
    </div>
    <select class="shuffle-select" id="sort-select" onchange="setSort(this.value)" title="Sort themes">
      <option value="az">A&ndash;Z</option>
      <option value="brightness">Brightness</option>
      <option value="hue">Hue</option>
    </select>
  </div>

  <div class="scheme-grid" id="scheme-grid"></div>
</div>

<div class="toast" id="toast"></div>

<script>
  let installedSchemes = [];
  let externalIndex = [];
  let favorites = [];
  let currentScheme = "";
  let currentSize = 13;
  let activeTab = "installed";
  let activeFilter = "all";
  let activeSort = "az";
  let shuffleActive = false;
  let shuffleFavsOnly = false;
  let currentOpacity = 95;
  let externalLoaded = false;
  let opacityTimer = null;
  let history = [];   // applied scheme names, oldest -> newest
  let histIndex = -1; // current position in history

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function isLightTheme(s) {
    if (!s || !s.background) return false;
    const hex = s.background.replace("#", "");
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128;
  }

  function filterSchemes(list) {
    if (activeFilter === "all") return list;
    return list.filter(s => activeFilter === "light" ? isLightTheme(s) : !isLightTheme(s));
  }

  function setFilter(f) {
    activeFilter = f;
    document.querySelectorAll(".filter-pill").forEach(p => p.classList.toggle("active", p.dataset.filter === f));
    renderGrid();
  }

  function brightness(s) {
    if (!s || !s.background) return 0;
    const h = s.background.replace("#", "");
    const r = parseInt(h.substr(0, 2), 16) || 0, g = parseInt(h.substr(2, 2), 16) || 0, b = parseInt(h.substr(4, 2), 16) || 0;
    return (r * 299 + g * 587 + b * 114) / 1000;
  }
  function hue(s) {
    const c = (s && (s.blue || s.green || s.red || s.foreground || s.background)) || "#000000";
    const h = c.replace("#", "");
    const r = (parseInt(h.substr(0, 2), 16) || 0) / 255, g = (parseInt(h.substr(2, 2), 16) || 0) / 255, b = (parseInt(h.substr(4, 2), 16) || 0) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    let hh;
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    return hh < 0 ? hh + 360 : hh;
  }
  function sortSchemes(list) {
    const arr = list.slice();
    if (activeSort === "brightness") arr.sort((a, b) => brightness(a) - brightness(b));
    else if (activeSort === "hue") arr.sort((a, b) => hue(a) - hue(b));
    else arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }
  function setSort(v) { activeSort = v; renderGrid(); }

  async function fetchState() {
    const res = await fetch("/api/state");
    const data = await res.json();
    installedSchemes = data.schemes;
    currentScheme = data.current;
    currentSize = data.font.size;
    favorites = data.favorites;
    shuffleActive = data.shuffle.active;
    shuffleFavsOnly = data.shuffle.favsOnly || false;
    currentOpacity = data.opacity;
    document.getElementById("installed-count").textContent = installedSchemes.length;
    document.getElementById("favorites-count").textContent = favorites.length;
    if (shuffleActive) {
      document.getElementById("shuffle-btn").classList.add("active");
      document.getElementById("shuffle-interval").value = String(data.shuffle.ms);
    }
    document.getElementById("favs-only-btn").classList.toggle("active", shuffleFavsOnly);
    document.getElementById("font-size").textContent = currentSize;
    document.getElementById("opacity-slider").value = currentOpacity;
    document.getElementById("opacity-value").textContent = currentOpacity + "%";
    history = [currentScheme];
    histIndex = 0;
    updateHistButtons();
    renderPreview();
    renderGrid();
  }

  function renderPreview() {
    const s = installedSchemes.find(s => s.name === currentScheme);
    if (!s) return;
    const preview = document.getElementById("terminal-preview");
    const titlebar = document.getElementById("tp-titlebar");
    const body = document.getElementById("tp-body");
    preview.style.background = s.background;
    titlebar.style.background = s.background;
    titlebar.style.borderBottom = "1px solid " + s.brightBlack;
    document.getElementById("tp-name").textContent = currentScheme;
    document.getElementById("tp-name").style.color = s.foreground;

    // Escape color values before concatenating into innerHTML (a malformed scheme color can't inject markup)
    const fg = esc(s.foreground), green = esc(s.green), blue = esc(s.blue),
      cyan = esc(s.cyan), yellow = esc(s.yellow), purple = esc(s.purple), red = esc(s.red);
    body.innerHTML =
      '<div class="line"><span style="color:' + green + '">maram@dev</span>' +
      '<span style="color:' + fg + '">:</span>' +
      '<span style="color:' + blue + '">~/projects</span>' +
      '<span style="color:' + fg + '">$ </span>' +
      '<span style="color:' + fg + '">node server.js</span></div>' +
      '<div class="line"><span style="color:' + cyan + '">INFO</span>' +
      '<span style="color:' + fg + '">  Server running on port </span>' +
      '<span style="color:' + yellow + '">3456</span></div>' +
      '<div class="line"><span style="color:' + green + '">OK</span>' +
      '<span style="color:' + fg + '">    Loaded </span>' +
      '<span style="color:' + purple + '">12 routes</span></div>' +
      '<div class="line"><span style="color:' + red + '">WARN</span>' +
      '<span style="color:' + fg + '">  No .env file found, using defaults</span></div>' +
      '<div class="line"><span style="color:' + green + '">maram@dev</span>' +
      '<span style="color:' + fg + '">:</span>' +
      '<span style="color:' + blue + '">~/projects</span>' +
      '<span style="color:' + yellow + '"> (main) </span>' +
      '<span style="color:' + fg + '">$ </span>' +
      '<span style="color:' + fg + '; opacity: 0.4">_</span></div>';

    // 16-color ANSI palette strip (normal row + bright row)
    const normal = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white"];
    const bright = normal.map(k => "bright" + k.charAt(0).toUpperCase() + k.slice(1));
    const swatch = keys => keys.map(k =>
      '<div class="pc" style="background:' + esc(s[k] || "transparent") + '"></div>').join("");
    document.getElementById("tp-palette").innerHTML =
      '<div class="palette-row">' + swatch(normal) + '</div>' +
      '<div class="palette-row">' + swatch(bright) + '</div>';
  }

  function renderGrid() {
    const query = document.getElementById("search").value.toLowerCase();
    const grid = document.getElementById("scheme-grid");
    let items = [];

    if (activeTab === "installed") {
      items = sortSchemes(filterSchemes(installedSchemes)
        .filter(s => s.name.toLowerCase().includes(query)))
        .map(s => schemeCard(s));
    } else if (activeTab === "favorites") {
      items = sortSchemes(filterSchemes(installedSchemes)
        .filter(s => favorites.includes(s.name) && s.name.toLowerCase().includes(query)))
        .map(s => schemeCard(s));
    } else if (activeTab === "explore") {
      if (!externalLoaded) {
        grid.innerHTML = '<div class="loading"><span class="spinner"></span>Loading 515+ themes from GitHub...</div>';
        loadExternal();
        return;
      }
      const installedNames = new Set(installedSchemes.map(s => s.name));
      items = externalIndex
        .filter(t => !installedNames.has(t.name) && t.name.toLowerCase().includes(query))
        .map(t => externalCard(t));
    }

    grid.innerHTML = items.join("");
  }

  function schemeCard(s) {
    const isActive = s.name === currentScheme ? " active" : "";
    const isFav = favorites.includes(s.name);
    const colors = [s.red, s.green, s.blue, s.yellow, s.purple, s.cyan].filter(Boolean);
    const bg = s.background || "#13131f";
    const fg = s.foreground || "#ccc";
    return '<div class="scheme-card' + isActive + '" data-name="' + esc(s.name) + '" style="background:' + esc(bg) + ';">' +
      '<div class="active-badge">&#10003;</div>' +
      '<div class="scheme-colors">' + colors.map(c => '<div class="c" style="background:' + esc(c) + '"></div>').join("") + '</div>' +
      '<div class="scheme-name" style="color:' + esc(fg) + '">' + esc(s.name) + '</div>' +
      '<button class="fav-btn' + (isFav ? ' favorited' : '') + '" data-fav="' + esc(s.name) + '" title="Toggle favorite">' +
      (isFav ? "&#9733;" : "&#9734;") + '</button></div>';
  }

  function externalCard(t) {
    return '<div class="scheme-card" data-ext-name="' + esc(t.name) + '" data-ext-url="' + esc(t.download_url) + '">' +
      '<div class="scheme-name">' + esc(t.name) + '</div>' +
      '<button class="install-btn">+ Install &amp; Apply</button></div>';
  }

  async function loadExternal() {
    const res = await fetch("/api/external-index");
    externalIndex = await res.json();
    externalLoaded = true;
    document.getElementById("explore-count").textContent = externalIndex.length;
    renderGrid();
  }

  function updateHistButtons() {
    document.getElementById("undo-btn").style.display = histIndex > 0 ? "inline-block" : "none";
    document.getElementById("redo-btn").style.display = histIndex < history.length - 1 ? "inline-block" : "none";
  }

  // Record an applied scheme onto the history stack (truncating any redo tail).
  function recordHistory(name) {
    if (history[histIndex] === name) { updateHistButtons(); return; }
    history = history.slice(0, histIndex + 1);
    history.push(name);
    if (history.length > 50) history.shift();
    histIndex = history.length - 1;
    updateHistButtons();
  }

  async function setSchemeServer(name) {
    const res = await fetch("/api/set-scheme", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    return res.json();
  }

  async function randomize() {
    const res = await fetch("/api/randomize", { method: "POST" });
    const data = await res.json();
    currentScheme = data.scheme;
    recordHistory(currentScheme);
    renderPreview();
    renderGrid();
    showToast("Switched to " + data.scheme);
  }

  async function pickScheme(name) {
    const data = await setSchemeServer(name);
    if (data.error) { showToast(data.error); return; }
    currentScheme = data.scheme;
    recordHistory(currentScheme);
    renderPreview();
    renderGrid();
    showToast(data.scheme);
  }

  async function undoTheme() {
    if (histIndex <= 0) return;
    const name = history[--histIndex];
    await setSchemeServer(name);
    currentScheme = name;
    renderPreview();
    renderGrid();
    updateHistButtons();
    showToast("Undo → " + name);
  }

  async function redoTheme() {
    if (histIndex >= history.length - 1) return;
    const name = history[++histIndex];
    await setSchemeServer(name);
    currentScheme = name;
    renderPreview();
    renderGrid();
    updateHistButtons();
    showToast("Redo → " + name);
  }

  async function randomFav() {
    const installedFavs = favorites.filter(n => installedSchemes.some(s => s.name === n));
    if (installedFavs.length === 0) { showToast("No favorites yet — star some themes"); return; }
    const pool = installedFavs.filter(n => n !== currentScheme);
    const from = pool.length ? pool : installedFavs;
    await pickScheme(from[Math.floor(Math.random() * from.length)]);
  }

  async function surprise() {
    showToast("Finding a surprise…");
    if (!externalLoaded) await loadExternal();
    const installedNames = new Set(installedSchemes.map(s => s.name));
    const pool = externalIndex.filter(t => !installedNames.has(t.name));
    if (pool.length === 0) { await randomize(); return; }
    const t = pool[Math.floor(Math.random() * pool.length)];
    const scheme = await installThemeData(t.name, t.download_url);
    if (scheme) await pickScheme(scheme.name);
    else showToast("Couldn't fetch that one — try again");
  }

  async function toggleFav(name) {
    const res = await fetch("/api/toggle-favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    favorites = data.favorites;
    document.getElementById("favorites-count").textContent = favorites.length;
    renderGrid();
    showToast(favorites.includes(name) ? "★ Favorited " + name : "Unfavorited " + name);
  }

  // Install a theme into settings.json; returns the slim scheme (or null) and updates local state.
  async function installThemeData(name, url) {
    const res = await fetch("/api/install-theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url })
    });
    const data = await res.json();
    if (data.scheme) {
      installedSchemes.push(data.scheme);
      document.getElementById("installed-count").textContent = installedSchemes.length;
      return data.scheme;
    }
    return null;
  }

  // Explore-tab handler: install the theme, then immediately apply it.
  async function installTheme(name, url, btn) {
    btn.textContent = "…";
    btn.disabled = true;
    const scheme = await installThemeData(name, url);
    if (scheme) {
      showToast("Installed " + name);
      await pickScheme(scheme.name);
    } else {
      btn.textContent = "+ Install & Apply";
      btn.disabled = false;
      showToast("Install failed");
    }
  }

  function toggleUiTheme() {
    const next = document.documentElement.getAttribute("data-ui-theme") === "light" ? "dark" : "light";
    try { localStorage.setItem("terminalizer-ui-theme", next); } catch (e) {}
    applyUiTheme(next);
  }
  function applyUiTheme(theme) {
    document.documentElement.setAttribute("data-ui-theme", theme);
    document.getElementById("ui-toggle").innerHTML = theme === "light" ? "☀" : "☽";
  }

  async function changeSize(delta) {
    const newSize = currentSize + delta;
    if (newSize < 8 || newSize > 30) return;
    const res = await fetch("/api/set-font-size", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: newSize })
    });
    const data = await res.json();
    currentSize = data.size;
    document.getElementById("font-size").textContent = currentSize;
  }

  async function toggleShuffle() {
    shuffleActive = !shuffleActive;
    const ms = parseInt(document.getElementById("shuffle-interval").value);
    await fetch("/api/shuffle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: shuffleActive, ms, favsOnly: shuffleFavsOnly })
    });
    document.getElementById("shuffle-btn").classList.toggle("active", shuffleActive);
    showToast(shuffleActive ? "Auto-shuffle ON" : "Auto-shuffle OFF");
  }

  async function toggleFavsOnly() {
    shuffleFavsOnly = !shuffleFavsOnly;
    document.getElementById("favs-only-btn").classList.toggle("active", shuffleFavsOnly);
    if (shuffleActive) {
      const ms = parseInt(document.getElementById("shuffle-interval").value);
      await fetch("/api/shuffle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, ms, favsOnly: shuffleFavsOnly })
      });
    }
    showToast(shuffleFavsOnly ? "Shuffle: favorites only" : "Shuffle: all themes");
  }

  async function updateShuffle() {
    if (!shuffleActive) return;
    const ms = parseInt(document.getElementById("shuffle-interval").value);
    await fetch("/api/shuffle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true, ms, favsOnly: shuffleFavsOnly })
    });
  }

  function updateOpacity(val) {
    currentOpacity = parseInt(val);
    document.getElementById("opacity-value").textContent = currentOpacity + "%";
    clearTimeout(opacityTimer);
    opacityTimer = setTimeout(async () => {
      await fetch("/api/set-opacity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opacity: currentOpacity })
      });
    }, 150);
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    document.getElementById("search").value = "";
    renderGrid();
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1800);
  }

  // Delegated grid clicks (cards rendered as innerHTML carry data-* attributes, no inline JS)
  document.getElementById("scheme-grid").addEventListener("click", (e) => {
    const favBtn = e.target.closest(".fav-btn");
    if (favBtn) { e.stopPropagation(); toggleFav(favBtn.dataset.fav); return; }
    const installBtn = e.target.closest(".install-btn");
    if (installBtn) {
      const card = installBtn.closest(".scheme-card");
      installTheme(card.dataset.extName, card.dataset.extUrl, installBtn);
      return;
    }
    const card = e.target.closest(".scheme-card[data-name]");
    if (card) pickScheme(card.dataset.name);
  });

  // Poll for shuffle changes (so undo works after an auto-shuffle pick too)
  setInterval(async () => {
    if (!shuffleActive) return;
    const res = await fetch("/api/current");
    const data = await res.json();
    if (data.current !== currentScheme) {
      currentScheme = data.current;
      recordHistory(currentScheme);
      renderPreview();
      renderGrid();
    }
  }, 5000);

  // Keyboard shortcuts: Space = randomize, U = undo, R = redo, F = favorite current, / = search
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "/" && !typing) { e.preventDefault(); document.getElementById("search").focus(); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); randomize(); }
    else if (e.key === "u" || e.key === "U") undoTheme();
    else if (e.key === "r" || e.key === "R") redoTheme();
    else if (e.key === "f" || e.key === "F") { if (currentScheme) toggleFav(currentScheme); }
  });

  // Restore saved UI theme (default dark) before first paint of state
  (function () {
    let saved = "dark";
    try { saved = localStorage.getItem("terminalizer-ui-theme") || "dark"; } catch (e) {}
    applyUiTheme(saved);
  })();

  fetchState();
</script>
</body>
</html>`;

// --- Server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = req.method + " " + url.pathname;

  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  try {

  if (req.method === "POST" && !originAllowed(req)) {
    json({ error: "Forbidden" }, 403);
    return;
  }

  if (route === "GET /") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (route === "GET /api/state") {
    const settings = readSettings();
    const schemes = settings.schemes.map(slimScheme);
    json({
      schemes,
      current: getCurrentScheme(settings),
      font: getFont(settings),
      favorites: loadFavorites(),
      shuffle: { active: !!shuffleInterval, ms: shuffleMs, favsOnly: shuffleFavsOnly },
      opacity: settings.profiles.defaults.opacity ?? 100,
    });
    return;
  }

  if (route === "GET /api/current") {
    const settings = readSettings();
    json({ current: getCurrentScheme(settings) });
    return;
  }

  if (route === "POST /api/randomize") {
    const settings = readSettings();
    const names = settings.schemes.map((s) => s.name);
    const current = getCurrentScheme(settings);
    const others = names.filter((n) => n !== current);
    if (others.length === 0) { json({ scheme: current }); return; }
    const pick = others[Math.floor(Math.random() * others.length)];
    settings.profiles.defaults.colorScheme = pick;
    writeSettings(settings);
    json({ scheme: pick });
    return;
  }

  if (route === "POST /api/set-scheme") {
    const { name } = await parseBody(req);
    const settings = readSettings();
    if (!settings.schemes.some((s) => s.name === name)) {
      json({ error: "Unknown scheme" }, 400);
      return;
    }
    settings.profiles.defaults.colorScheme = name;
    writeSettings(settings);
    json({ scheme: name });
    return;
  }

  if (route === "POST /api/set-font-size") {
    const { size } = await parseBody(req);
    if (size < 8 || size > 30) { json({ error: "Out of range" }, 400); return; }
    const settings = readSettings();
    const font = getFont(settings);
    font.size = size;
    settings.profiles.defaults.font = font;
    writeSettings(settings);
    json({ size });
    return;
  }

  if (route === "POST /api/toggle-favorite") {
    const { name } = await parseBody(req);
    const favs = loadFavorites();
    const idx = favs.indexOf(name);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(name);
    saveFavorites(favs);
    json({ favorites: favs });
    return;
  }

  if (route === "POST /api/shuffle") {
    const { active, ms, favsOnly } = await parseBody(req);
    if (active) startShuffle(ms, favsOnly);
    else stopShuffle();
    json({ active: !!shuffleInterval, ms: shuffleMs, favsOnly: shuffleFavsOnly });
    return;
  }

  if (route === "POST /api/set-opacity") {
    const { opacity } = await parseBody(req);
    if (opacity < 30 || opacity > 100) { json({ error: "Out of range" }, 400); return; }
    const settings = readSettings();
    settings.profiles.defaults.opacity = opacity;
    settings.profiles.defaults.useAcrylic = opacity < 100;
    writeSettings(settings);
    json({ opacity });
    return;
  }

  if (route === "GET /api/external-index") {
    try {
      const themes = await fetchExternalIndex();
      json(themes);
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  if (route === "POST /api/install-theme") {
    const { name, url: themeUrl } = await parseBody(req);
    try {
      if (!isAllowedThemeUrl(themeUrl)) { json({ error: "Disallowed theme URL" }, 400); return; }
      const theme = await fetchExternalTheme(themeUrl);
      if (!theme) { json({ error: "Failed to fetch" }, 500); return; }
      const settings = readSettings();
      if (settings.schemes.some((s) => s.name === name)) {
        json({ error: "Already installed" }, 400);
        return;
      }
      settings.schemes.push(theme);
      writeSettings(settings);
      json({ scheme: slimScheme(theme) });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");

  } catch (e) {
    // Any thrown error (e.g. settings.json missing/unreadable) becomes a clean 500
    // instead of an unhandled rejection that hangs the request.
    if (!res.headersSent) json({ error: e.message }, 500);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`The Terminalizer running at http://localhost:${PORT}`);
});
