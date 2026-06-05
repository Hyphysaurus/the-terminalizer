#!/usr/bin/env node
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

function findSettingsPath() {
  // Stable Store build, Preview Store build, and unpackaged (winget/zip) install — in priority order.
  const rels = [
    "AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
    "AppData/Local/Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
    "AppData/Local/Microsoft/Windows Terminal/settings.json",
  ];
  // Native Windows
  if (process.platform === "win32") {
    const home = os.homedir();
    for (const r of rels) { const p = path.join(home, r); if (fs.existsSync(p)) return p; }
    return path.join(home, rels[0]);
  }
  // WSL — detect the Windows user under /mnt/c/Users
  try {
    const base = "/mnt/c/Users";
    for (const u of fs.readdirSync(base)) {
      if (["Default", "Public", "Default User", "All Users"].includes(u)) continue;
      for (const r of rels) { const p = path.join(base, u, r); if (fs.existsSync(p)) return p; }
    }
  } catch {}
  console.error("Could not find Windows Terminal settings.json. Set TERMINAL_SETTINGS_PATH to its location.");
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

function readRaw() { return fs.readFileSync(SETTINGS_PATH, "utf-8"); }

function backupOnce() {
  try {
    if (!fs.existsSync(BACKUP_PATH) && fs.existsSync(SETTINGS_PATH)) {
      fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH);
    }
  } catch {}
}

// Atomic write: temp file in the same dir, then rename over the target,
// so a crash mid-write can never leave a corrupted settings.json.
function atomicWrite(text) {
  const tmp = SETTINGS_PATH + ".terminalizer.tmp";
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, SETTINGS_PATH);
}

// Write raw edited text, but only after confirming it still parses. Throws otherwise.
function commitRaw(text) {
  parseJsonc(text); // validate — throws if the surgical edit produced invalid JSON
  backupOnce();
  atomicWrite(text);
}

// Full re-serialize (loses JSONC comments). Safe fallback + used for opt-in bulk edits.
function writeSettings(settings) {
  backupOnce();
  atomicWrite(JSON.stringify(settings, null, 4));
}

function ensureDefaults(s) {
  if (!s.profiles) s.profiles = {};
  if (!s.profiles.defaults) s.profiles.defaults = {};
  return s;
}

/* ---- Comment-preserving surgical JSONC editing ----
   These edit the raw settings text in place so user comments/formatting survive.
   Every public helper validates the result (commitRaw re-parses) and returns false
   on any doubt, so callers fall back to the full re-serialize path. */
function scanString(text, i) { // i at opening quote -> index just past closing quote
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}
function matchBracket(text, i) { // i at { or [ -> index just past matching } or ]
  const open = text[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, inLine = false, inBlock = false;
  for (; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
function skipWs(text, k) {
  for (;;) {
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === "/" && text[k + 1] === "/") { while (k < text.length && text[k] !== "\n") k++; continue; }
    if (text[k] === "/" && text[k + 1] === "*") { k += 2; while (k < text.length && !(text[k] === "*" && text[k + 1] === "/")) k++; k += 2; continue; }
    return k;
  }
}
// Index of the opening quote of `key` at the top level of the object at objStart..objEnd, or -1.
function findKeyInObject(text, objStart, objEnd, key) {
  const target = '"' + key + '"';
  for (let i = objStart + 1; i < objEnd; i++) {
    const c = text[i], n = text[i + 1];
    if (c === "/" && n === "/") { while (i < objEnd && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < objEnd && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    if (c === "{" || c === "[") { const e = matchBracket(text, i); if (e > 0) { i = e - 1; continue; } }
    if (c === '"') {
      if (text.startsWith(target, i) && text[skipWs(text, scanString(text, i))] === ":") return i;
      const e = scanString(text, i); if (e > 0) { i = e - 1; continue; }
    }
  }
  return -1;
}
function valueStart(text, keyQuoteIdx) { // -> index of first significant char of the value
  const k = skipWs(text, scanString(text, keyQuoteIdx));
  if (text[k] !== ":") return -1;
  return skipWs(text, k + 1);
}
function scalarEnd(text, i) { // end of a string or scalar value beginning at i
  if (text[i] === '"') return scanString(text, i);
  while (i < text.length && !/[,}\]\s]/.test(text[i]) && text[i] !== "/") i++;
  return i;
}
function indentOf(text, idx) {
  let s = text.lastIndexOf("\n", idx) + 1, ind = "";
  while (s < text.length && (text[s] === " " || text[s] === "\t")) { ind += text[s]; s++; }
  return ind;
}
// Walk a path of object keys (e.g. ["profiles","defaults"]) -> {start,end} of the leaf object braces.
function childObject(text, start, end, pathKeys) {
  for (const key of pathKeys) {
    const ki = findKeyInObject(text, start, end, key);
    if (ki < 0) return null;
    const vs = valueStart(text, ki);
    if (text[vs] !== "{") return null;
    const ve = matchBracket(text, vs);
    if (ve < 0) return null;
    start = vs; end = ve;
  }
  return { start, end };
}
function withRoot(text) {
  const rs = text.indexOf("{");
  const re = rs < 0 ? -1 : matchBracket(text, rs);
  if (rs < 0 || re < 0) throw new Error("bad root");
  return { rs, re };
}
// Replace `key`'s value with `literal` in the object at objStart..objEnd, or insert it.
function setKeyRaw(text, objStart, objEnd, key, literal) {
  const ki = findKeyInObject(text, objStart, objEnd, key);
  if (ki >= 0) {
    const vs = valueStart(text, ki);
    return text.slice(0, vs) + literal + text.slice(scalarEnd(text, vs));
  }
  const ins = "\n" + indentOf(text, objStart) + '    "' + key + '": ' + literal + ",";
  return text.slice(0, objStart + 1) + ins + text.slice(objStart + 1);
}

// Public: set scalar keys on profiles.defaults, preserving comments. Returns success.
function surgicalSetDefaults(pairs) {
  try {
    let text = readRaw();
    for (const [k, v] of Object.entries(pairs)) {
      const { rs, re } = withRoot(text);
      const def = childObject(text, rs, re, ["profiles", "defaults"]);
      if (!def) return false;
      text = setKeyRaw(text, def.start, def.end, k, JSON.stringify(v));
    }
    commitRaw(text);
    return true;
  } catch { return false; }
}
function surgicalSetFontSize(size) {
  try {
    let text = readRaw();
    const { rs, re } = withRoot(text);
    const def = childObject(text, rs, re, ["profiles", "defaults"]);
    if (!def) return false;
    const fk = findKeyInObject(text, def.start, def.end, "font");
    if (fk >= 0) {
      const fv = valueStart(text, fk);
      if (text[fv] === "{") {
        text = setKeyRaw(text, fv, matchBracket(text, fv), "size", String(size));
      } else if (text[fv] === '"') {
        const fe = scanString(text, fv);
        text = text.slice(0, fv) + '{ "face": ' + text.slice(fv, fe) + ', "size": ' + size + " }" + text.slice(fe);
      } else return false;
    } else {
      text = setKeyRaw(text, def.start, def.end, "font", '{ "size": ' + size + " }");
    }
    commitRaw(text);
    return true;
  } catch { return false; }
}
function surgicalPushScheme(schemeObj) {
  try {
    let text = readRaw();
    const { rs, re } = withRoot(text);
    const sk = findKeyInObject(text, rs, re, "schemes");
    if (sk < 0) return false;
    const vs = valueStart(text, sk);
    if (text[vs] !== "[") return false;
    const ve = matchBracket(text, vs);
    let j = ve - 2; // last significant char before the closing ]
    while (j > vs && /\s/.test(text[j])) j--;
    // Need a separator only if the previous element isn't already followed by a comma
    // (an existing trailing comma) and the array isn't empty.
    const last = text[j];
    const needComma = last !== "[" && last !== ",";
    const serialized = JSON.stringify(schemeObj, null, 4).split("\n").map((l, idx) => idx === 0 ? l : "        " + l).join("\n");
    const insertAt = j + 1;
    text = text.slice(0, insertAt) + (needComma ? "," : "") + "\n        " + serialized + text.slice(insertAt);
    commitRaw(text);
    return true;
  } catch { return false; }
}
function getDefaults(settings) {
  return (settings.profiles && settings.profiles.defaults) || {};
}
function getCurrentScheme(settings) {
  return getDefaults(settings).colorScheme || "Tokyo Night";
}
function getFont(settings) {
  return getDefaults(settings).font || { face: "JetBrainsMono Nerd Font", size: 13, weight: "normal" };
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

// --- Apply a color scheme (comment-preserving when possible) ---
let applyAllProfiles = false;

function applyColorScheme(name) {
  if (applyAllProfiles) {
    const s = ensureDefaults(readSettings());
    s.profiles.defaults.colorScheme = name;
    if (Array.isArray(s.profiles.list)) {
      s.profiles.list.forEach((p) => { if (p && typeof p === "object") p.colorScheme = name; });
    }
    writeSettings(s); // full path (comments lost) — opt-in bulk action
    return;
  }
  if (surgicalSetDefaults({ colorScheme: name })) return;
  const s = ensureDefaults(readSettings());
  s.profiles.defaults.colorScheme = name;
  writeSettings(s);
}

// --- Auto-shuffle ---
let shuffleInterval = null;
let shuffleMs = 0;
let shuffleFavsOnly = false;
let lastShuffleActivity = 0;

function startShuffle(ms, favsOnly = false) {
  stopShuffle();
  shuffleMs = ms;
  shuffleFavsOnly = favsOnly;
  lastShuffleActivity = Date.now();
  shuffleInterval = setInterval(() => {
    // Auto-stop if the UI has gone quiet (tab closed) so we don't rewrite settings.json forever.
    if (Date.now() - lastShuffleActivity > 60000) { stopShuffle(); return; }
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
    applyColorScheme(pool[Math.floor(Math.random() * pool.length)]);
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
    /* Daft Punk — Gold helmet (black glass + metallic gold) [default / data-ui-theme="dark"] */
    :root {
      --bg: #070707;
      --bg-gradient: radial-gradient(ellipse 120% 90% at 50% -15%, #241d0c 0%, #14110a 32%, #0a0a0a 66%, #050505 100%);
      --glow-a: radial-gradient(circle, rgba(243,201,105,0.5), transparent 70%);
      --glow-b: radial-gradient(circle, rgba(212,166,55,0.42), transparent 70%);
      --glow-c: radial-gradient(circle, rgba(255,180,60,0.36), transparent 70%);
      --grid: rgba(243,201,105,0.05); --mote: rgba(245,210,130,0.95); --scan: rgba(243,201,105,0.55);
      --title-grad: linear-gradient(180deg, #fbe7a6 0%, #f3c969 45%, #b8862e 76%, #f6d98a 100%);
      --glass-bg: rgba(255,255,255,0.05); --glass-bg-strong: rgba(255,255,255,0.10);
      --glass-border: rgba(243,201,105,0.30); --glass-hi: rgba(255,240,200,0.32);
      --glass-shadow: 0 10px 34px rgba(0,0,0,0.6); --blur: blur(14px) saturate(1.2);
      --surface: rgba(255,255,255,0.05); --surface-2: rgba(0,0,0,0.42); --surface-3: rgba(243,201,105,0.14);
      --accent-bg: rgba(243,201,105,0.18); --accent-count: rgba(243,201,105,0.28);
      --border: rgba(243,201,105,0.26); --border-strong: rgba(243,201,105,0.55);
      --border-soft: rgba(255,255,255,0.10); --border-faint: rgba(255,255,255,0.07);
      --text: #ece4d2; --text-strong: #fff6e2; --text-dim: #b9ad92; --text-mid: #d8ccae;
      --text-faint: #8a8068; --text-ghost: #6f6754; --placeholder: #7a715b;
      --accent: #f6d98a; --accent-2: #c9972e; --accent-soft: #f3c969;
      --card-border: rgba(243,201,105,0.18); --card-border-hover: rgba(243,201,105,0.6);
      --shadow: rgba(0,0,0,0.5); --shadow-strong: rgba(0,0,0,0.7);
    }
    /* Daft Punk — Chrome helmet (black glass + cyan chrome) */
    :root[data-ui-theme="light"] {
      --bg: #060708;
      --bg-gradient: radial-gradient(ellipse 120% 90% at 50% -15%, #0c1f29 0%, #0a141a 32%, #070b0d 66%, #040506 100%);
      --glow-a: radial-gradient(circle, rgba(127,223,255,0.46), transparent 70%);
      --glow-b: radial-gradient(circle, rgba(160,180,200,0.36), transparent 70%);
      --glow-c: radial-gradient(circle, rgba(90,200,255,0.32), transparent 70%);
      --grid: rgba(127,223,255,0.06); --mote: rgba(200,238,255,0.95); --scan: rgba(127,223,255,0.55);
      --title-grad: linear-gradient(180deg, #eafaff 0%, #bfe6f5 45%, #6f93a6 78%, #dff2fb 100%);
      --glass-bg: rgba(255,255,255,0.06); --glass-bg-strong: rgba(255,255,255,0.12);
      --glass-border: rgba(170,210,230,0.34); --glass-hi: rgba(220,245,255,0.38);
      --glass-shadow: 0 10px 34px rgba(0,0,0,0.55); --blur: blur(14px) saturate(1.2);
      --surface: rgba(255,255,255,0.06); --surface-2: rgba(0,0,0,0.42); --surface-3: rgba(170,210,230,0.16);
      --accent-bg: rgba(127,223,255,0.18); --accent-count: rgba(127,223,255,0.28);
      --border: rgba(170,210,230,0.32); --border-strong: rgba(127,223,255,0.6);
      --border-soft: rgba(255,255,255,0.10); --border-faint: rgba(255,255,255,0.07);
      --text: #dceaf0; --text-strong: #f2fbff; --text-dim: #9fb3bd; --text-mid: #c2d4dd;
      --text-faint: #6f828c; --text-ghost: #5b6c75; --placeholder: #6a7d87;
      --accent: #aee9ff; --accent-2: #3aa9d6; --accent-soft: #7fdfff;
      --card-border: rgba(170,210,230,0.20); --card-border-hover: rgba(127,223,255,0.6);
      --shadow: rgba(0,0,0,0.5); --shadow-strong: rgba(0,0,0,0.7);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      font-family: 'Inter', -apple-system, system-ui, sans-serif;
      background: var(--bg-gradient) fixed;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      transition: color 0.3s ease;
    }

    /* Daft Punk ambient: Tron grid + drifting LED motes + visor scanline */
    .aero-bg { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: -1; }
    .aero-bg::before {
      content: ''; position: absolute; inset: -2px;
      background-image:
        linear-gradient(var(--grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 46px 46px;
      -webkit-mask-image: radial-gradient(ellipse 95% 75% at 50% 38%, #000 25%, transparent 82%);
      mask-image: radial-gradient(ellipse 95% 75% at 50% 38%, #000 25%, transparent 82%);
    }
    .aero-bg .orb { position: absolute; border-radius: 50%; filter: blur(60px); opacity: 0.55; }
    .orb-1 { width: 380px; height: 380px; top: -110px; left: -80px; background: var(--glow-a); }
    .orb-2 { width: 300px; height: 300px; top: 26%; right: -90px; background: var(--glow-b); }
    .orb-3 { width: 460px; height: 460px; bottom: -170px; left: 30%; background: var(--glow-c); }
    .bubble {
      position: absolute; bottom: -40px; border-radius: 2px;
      background: var(--mote); box-shadow: 0 0 8px 1px var(--mote);
      opacity: 0; animation: aero-rise linear infinite;
    }
    @keyframes aero-rise {
      0% { transform: translate(0, 0); opacity: 0; }
      14% { opacity: 0.9; }
      86% { opacity: 0.5; }
      100% { transform: translate(24px, -112vh); opacity: 0; }
    }
    .scanline {
      position: absolute; left: 0; right: 0; height: 2px; top: -2%;
      background: linear-gradient(90deg, transparent, var(--scan) 25%, var(--scan) 75%, transparent);
      box-shadow: 0 0 14px 2px var(--scan); opacity: 0.45;
      animation: aero-scan 7s linear infinite;
    }
    @keyframes aero-scan { 0% { top: -2%; } 100% { top: 102%; } }
    @media (prefers-reduced-motion: reduce) { .bubble, .scanline { animation: none; display: none; } }
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
      font-size: 1.7rem; margin-bottom: 0.35rem;
      font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
      background: var(--title-grad);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent; color: transparent;
      filter: drop-shadow(0 1px 1px rgba(0,0,0,0.6));
    }
    .subtitle { font-size: 0.82rem; color: var(--text-dim); font-weight: 500; letter-spacing: 0.01em; }

    /* Daft Punk helmet red LED scanner (Cylon sweep) */
    .red-scanner {
      position: relative; height: 3px; width: 190px; margin: 1rem auto 0;
      border-radius: 3px; overflow: hidden;
      background: rgba(255,40,40,0.08);
      box-shadow: inset 0 0 0 1px rgba(255,60,60,0.16);
    }
    .red-scanner .led {
      position: absolute; top: 0; bottom: 0; left: -40px; width: 40px; border-radius: 3px;
      background: linear-gradient(90deg, transparent, #ff2a2a 42%, #ff6a6a 50%, #ff2a2a 58%, transparent);
      box-shadow: 0 0 10px 2px rgba(255,40,40,0.85), 0 0 22px 5px rgba(255,30,30,0.5);
      animation: red-scan 2.2s cubic-bezier(0.45,0,0.55,1) infinite alternate;
    }
    @keyframes red-scan { from { left: -40px; } to { left: 190px; } }
    @media (prefers-reduced-motion: reduce) {
      .red-scanner .led { animation: none; left: 75px; }
    }

    /* UI light/dark toggle */
    .ui-toggle {
      position: absolute; right: 0; top: 0;
      background: var(--surface); border: 1px solid var(--glass-border); color: var(--accent);
      width: 36px; height: 36px; border-radius: 50%; cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 1.05rem;
      transition: all 0.2s ease;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi), 0 4px 14px var(--shadow);
    }
    .ui-toggle:hover { border-color: var(--accent); transform: scale(1.08); }

    /* Terminal Preview */
    .terminal-preview {
      position: relative;
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 1.75rem;
      border: 1px solid var(--glass-border);
      font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      transition: background 0.35s ease, border-color 0.2s ease;
      box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
    }
    /* glossy glass reflection across the screen */
    .terminal-preview::after {
      content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 2;
      background: linear-gradient(158deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.06) 20%, transparent 42%);
    }
    .terminal-titlebar, .terminal-body, .palette-strip { position: relative; z-index: 1; }
    /* subtle CRT scanlines + flicker on the "screen" */
    .terminal-preview::before {
      content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 3;
      background: repeating-linear-gradient(rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.045) 2px 3px);
      animation: crt-flicker 4s steps(40) infinite;
    }
    @keyframes crt-flicker { 0%,100%{opacity:.55} 47%{opacity:.72} 49%{opacity:.4} 51%{opacity:.66} 53%{opacity:.5} }
    @media (prefers-reduced-motion: reduce) { .terminal-preview::before { animation: none; } }

    /* cursor/selection color swatches */
    .color-input {
      width: 30px; height: 24px; border-radius: 7px; cursor: pointer; padding: 2px;
      border: 1px solid var(--glass-border); background: var(--surface);
    }
    .color-input::-webkit-color-swatch { border: none; border-radius: 4px; }
    .color-input::-webkit-color-swatch-wrapper { padding: 0; }
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
      background:
        linear-gradient(to bottom, rgba(255,255,255,0.6), rgba(255,255,255,0.05) 48%, rgba(0,0,0,0.04) 52%, rgba(0,0,0,0.12)),
        linear-gradient(to bottom, var(--accent), var(--accent-2));
      color: #0c0c0e;
      border: 1px solid rgba(255,255,255,0.55);
      text-shadow: 0 1px 0 rgba(255,255,255,0.45);
      box-shadow: 0 6px 18px var(--shadow-strong), inset 0 1px 0 rgba(255,255,255,0.9);
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 26px var(--shadow-strong), inset 0 1px 0 rgba(255,255,255,0.95);
      filter: brightness(1.06) saturate(1.1);
    }
    .btn-primary:active { transform: translateY(0) scale(0.97); }
    .btn-secondary {
      background: var(--surface);
      color: var(--text);
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi), 0 3px 12px var(--shadow);
    }
    .btn-secondary:hover { border-color: var(--accent); color: var(--text-strong); background: var(--surface-3); }
    .btn-secondary.active {
      border-color: var(--accent-2);
      color: var(--text-strong);
      background: var(--accent-bg);
      box-shadow: 0 0 16px var(--accent-bg), inset 0 1px 0 var(--glass-hi);
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
      background: var(--surface); border: 1px solid var(--glass-border); color: var(--text);
      width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.9rem; font-weight: 500; transition: all 0.2s ease;
      font-family: 'Inter', system-ui, sans-serif;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi);
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
      background: var(--surface); border: 1px solid var(--glass-border); color: var(--text);
      padding: 0.45rem 0.65rem; border-radius: 10px; font-size: 0.78rem;
      font-family: 'Inter', system-ui, sans-serif; cursor: pointer;
      font-weight: 500; transition: all 0.2s ease;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi);
    }
    .shuffle-select:hover { border-color: var(--border-strong); color: var(--text-mid); }
    .shuffle-select:focus { outline: none; border-color: var(--accent); }

    /* Opacity slider */
    .slider-row {
      display: flex; align-items: center; gap: 10px;
      background: var(--surface); border: 1px solid var(--glass-border);
      border-radius: 14px; padding: 0.6rem 1.1rem;
      margin-bottom: 1.75rem;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: var(--glass-shadow), inset 0 1px 0 var(--glass-hi);
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
      background: var(--surface);
      border: 1px solid var(--glass-border);
      color: var(--text);
      padding: 0.6rem 1rem;
      border-radius: 12px;
      font-size: 0.82rem;
      font-family: 'Inter', system-ui, sans-serif;
      font-weight: 400;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi);
    }
    .search-bar:focus {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(122,162,247,0.1);
    }
    .search-bar::placeholder { color: var(--placeholder); }
    .filter-pills { display: flex; gap: 4px; flex-shrink: 0; }
    .filter-pill {
      background: var(--surface); border: 1px solid var(--glass-border); color: var(--text-dim);
      padding: 0.45rem 0.8rem; border-radius: 10px; font-size: 0.72rem;
      cursor: pointer; font-family: 'Inter', system-ui, sans-serif;
      font-weight: 600; transition: all 0.2s ease; letter-spacing: 0.02em;
      -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
      box-shadow: inset 0 1px 0 var(--glass-hi);
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
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 0.6rem 0.85rem;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 10px;
      position: relative;
      box-shadow: 0 3px 10px var(--shadow), inset 0 1px 0 rgba(255,255,255,0.25);
    }
    /* glossy top sheen on each card */
    .scheme-card::before {
      content: ''; position: absolute; left: 1px; right: 1px; top: 1px; height: 46%;
      border-radius: 11px 11px 40% 40% / 11px 11px 20px 20px;
      background: linear-gradient(to bottom, rgba(255,255,255,0.34), rgba(255,255,255,0));
      pointer-events: none; z-index: 0;
    }
    .scheme-card > * { position: relative; z-index: 1; }
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
      background: var(--accent-bg); border: 1px solid var(--accent); color: var(--text-strong);
      font-size: 0.68rem; padding: 4px 10px; border-radius: 8px;
      cursor: pointer; flex-shrink: 0; font-family: 'Inter', system-ui, sans-serif;
      font-weight: 600; transition: all 0.2s ease;
      box-shadow: inset 0 1px 0 var(--glass-hi);
    }
    .install-btn:hover { background: var(--accent); color: #0c0c0e; }

    /* Loading */
    .loading { text-align: center; padding: 2rem; color: var(--text-ghost); font-size: 0.85rem; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; vertical-align: middle; }
    /* Daft Punk pyramid loader */
    .pyramid {
      display: inline-block; width: 0; height: 0; vertical-align: middle; margin-right: 10px;
      border-left: 8px solid transparent; border-right: 8px solid transparent;
      border-bottom: 14px solid var(--accent);
      filter: drop-shadow(0 0 6px var(--accent));
      animation: pyramid-pulse 1.2s ease-in-out infinite;
    }
    @keyframes pyramid-pulse { 0%,100%{ opacity:.4; transform:scale(.85); } 50%{ opacity:1; transform:scale(1.12); } }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Toast */
    .toast {
      position: fixed; bottom: 2rem; left: 50%;
      transform: translateX(-50%) translateY(100px);
      background:
        linear-gradient(to bottom, rgba(255,255,255,0.5), rgba(255,255,255,0) 50%),
        linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #0c0c0e;
      border: 1px solid rgba(255,255,255,0.5);
      padding: 0.6rem 1.6rem; border-radius: 12px;
      font-weight: 600; font-size: 0.78rem;
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: 0.01em;
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none; z-index: 100;
      box-shadow: 0 8px 24px rgba(122,162,247,0.3);
    }
    .toast.show { transform: translateX(-50%) translateY(0); animation: toast-glitch 0.32s steps(3) 1; }
    @keyframes toast-glitch {
      0%   { clip-path: inset(0 0 62% 0); transform: translateX(-53%) translateY(0); }
      30%  { clip-path: inset(45% 0 0 0); transform: translateX(-47%) translateY(0); }
      60%  { clip-path: inset(0 0 22% 0); transform: translateX(-50%) translateY(0); }
      100% { clip-path: inset(0 0 0 0);   transform: translateX(-50%) translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) { .toast.show { animation: none; } }
  </style>
</head>
<body>
<div class="aero-bg" aria-hidden="true">
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="orb orb-3"></div>
  <div class="scanline"></div>
  <span class="bubble" style="left:5%;width:4px;height:4px;animation-duration:16s;animation-delay:-3s"></span>
  <span class="bubble" style="left:13%;width:6px;height:6px;animation-duration:22s;animation-delay:-9s"></span>
  <span class="bubble" style="left:22%;width:3px;height:3px;animation-duration:13s;animation-delay:-5s"></span>
  <span class="bubble" style="left:34%;width:5px;height:5px;animation-duration:19s;animation-delay:-1s"></span>
  <span class="bubble" style="left:43%;width:3px;height:3px;animation-duration:12s;animation-delay:-7s"></span>
  <span class="bubble" style="left:52%;width:6px;height:6px;animation-duration:24s;animation-delay:-4s"></span>
  <span class="bubble" style="left:61%;width:4px;height:4px;animation-duration:17s;animation-delay:-11s"></span>
  <span class="bubble" style="left:70%;width:3px;height:3px;animation-duration:14s;animation-delay:-2s"></span>
  <span class="bubble" style="left:79%;width:5px;height:5px;animation-duration:21s;animation-delay:-8s"></span>
  <span class="bubble" style="left:88%;width:4px;height:4px;animation-duration:18s;animation-delay:-6s"></span>
  <span class="bubble" style="left:95%;width:6px;height:6px;animation-duration:23s;animation-delay:-10s"></span>
</div>
<div class="app">
  <header>
    <button class="ui-toggle" id="ui-toggle" onclick="toggleUiTheme()" title="Toggle Gold / Chrome helmet">&#9737;</button>
    <h1>The Terminalizer</h1>
    <p class="subtitle">Randomize, preview, and hot-swap your Windows Terminal themes</p>
    <div class="red-scanner" aria-hidden="true"><span class="led"></span></div>
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

  <!-- Cursor / selection colors + apply-all + export -->
  <div class="slider-row" style="gap:12px;flex-wrap:wrap">
    <label>Cursor</label>
    <input type="color" id="cursor-color" class="color-input" value="#ffffff" onchange="setColor('cursorColor', this.value)" title="Override cursor color">
    <label>Selection</label>
    <input type="color" id="selection-color" class="color-input" value="#444444" onchange="setColor('selectionBackground', this.value)" title="Override selection color">
    <button class="btn btn-secondary" id="reset-colors-btn" onclick="resetColors()" style="padding:0.4rem 0.9rem" title="Clear overrides, use the scheme's own colors">Reset</button>
    <span style="flex:1"></span>
    <button class="btn btn-secondary" id="apply-all-btn" onclick="toggleApplyAll()" style="padding:0.4rem 0.9rem" title="Apply scheme changes to every profile, not just defaults">All profiles</button>
    <button class="btn btn-secondary" id="export-btn" onclick="exportScheme()" style="padding:0.4rem 0.9rem" title="Copy the current scheme JSON to clipboard">Export</button>
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
  let overrides = { cursorColor: null, selectionBackground: null };
  let applyAll = false;

  function hex6(v) { return /^#[0-9a-fA-F]{6}$/.test(v || "") ? v : null; }

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
    overrides = data.overrides || { cursorColor: null, selectionBackground: null };
    applyAll = !!data.applyAll;
    document.getElementById("apply-all-btn").classList.toggle("active", applyAll);
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

    // reflect cursor/selection colors (override if set, else the scheme's own)
    document.getElementById("cursor-color").value = hex6(overrides.cursorColor) || hex6(s.cursorColor) || "#ffffff";
    document.getElementById("selection-color").value = hex6(overrides.selectionBackground) || hex6(s.selectionBackground) || "#444444";
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
        grid.innerHTML = '<div class="loading"><span class="pyramid"></span>Loading 515+ themes from GitHub...</div>';
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
    document.getElementById("ui-toggle").innerHTML = theme === "light" ? "◎" : "◉";
  }

  async function setColor(target, value) {
    overrides[target] = value;
    await fetch("/api/set-color", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, value })
    });
    showToast((target === "cursorColor" ? "Cursor" : "Selection") + " color set");
  }
  async function resetColors() {
    overrides = { cursorColor: null, selectionBackground: null };
    for (const target of ["cursorColor", "selectionBackground"]) {
      await fetch("/api/set-color", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, value: null })
      });
    }
    renderPreview();
    showToast("Cursor & selection reset to scheme");
  }
  async function toggleApplyAll() {
    applyAll = !applyAll;
    document.getElementById("apply-all-btn").classList.toggle("active", applyAll);
    await fetch("/api/apply-all", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: applyAll })
    });
    showToast(applyAll ? "Applying to ALL profiles" : "Applying to defaults only");
  }
  async function exportScheme() {
    const s = installedSchemes.find(x => x.name === currentScheme);
    if (!s) return;
    try { await navigator.clipboard.writeText(JSON.stringify(s, null, 4)); showToast("Copied " + s.name + " JSON"); }
    catch (e) { showToast("Copy blocked by browser"); }
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

  // Restore saved UI theme (default Gold helmet) before first paint of state
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
    lastShuffleActivity = Date.now();
    const settings = readSettings();
    const defaults = getDefaults(settings);
    json({
      schemes: (settings.schemes || []).map(slimScheme),
      current: getCurrentScheme(settings),
      font: getFont(settings),
      favorites: loadFavorites(),
      shuffle: { active: !!shuffleInterval, ms: shuffleMs, favsOnly: shuffleFavsOnly },
      opacity: defaults.opacity ?? 100,
      applyAll: applyAllProfiles,
      overrides: { cursorColor: defaults.cursorColor || null, selectionBackground: defaults.selectionBackground || null },
    });
    return;
  }

  if (route === "GET /api/current") {
    lastShuffleActivity = Date.now();
    json({ current: getCurrentScheme(readSettings()) });
    return;
  }

  if (route === "POST /api/randomize") {
    const settings = readSettings();
    const current = getCurrentScheme(settings);
    const others = (settings.schemes || []).map((s) => s.name).filter((n) => n !== current);
    if (others.length === 0) { json({ scheme: current }); return; }
    const pick = others[Math.floor(Math.random() * others.length)];
    applyColorScheme(pick);
    json({ scheme: pick });
    return;
  }

  if (route === "POST /api/set-scheme") {
    const { name } = await parseBody(req);
    const settings = readSettings();
    if (!(settings.schemes || []).some((s) => s.name === name)) {
      json({ error: "Unknown scheme" }, 400);
      return;
    }
    applyColorScheme(name);
    json({ scheme: name });
    return;
  }

  if (route === "POST /api/set-font-size") {
    const { size } = await parseBody(req);
    if (size < 8 || size > 30) { json({ error: "Out of range" }, 400); return; }
    if (!surgicalSetFontSize(size)) {
      const settings = ensureDefaults(readSettings());
      const font = getFont(settings);
      font.size = size;
      settings.profiles.defaults.font = font;
      writeSettings(settings);
    }
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
    if (!surgicalSetDefaults({ opacity, useAcrylic: opacity < 100 })) {
      const settings = ensureDefaults(readSettings());
      settings.profiles.defaults.opacity = opacity;
      settings.profiles.defaults.useAcrylic = opacity < 100;
      writeSettings(settings);
    }
    json({ opacity });
    return;
  }

  if (route === "POST /api/apply-all") {
    const { on } = await parseBody(req);
    applyAllProfiles = !!on;
    json({ applyAll: applyAllProfiles });
    return;
  }

  if (route === "POST /api/set-color") {
    const { target, value } = await parseBody(req);
    if (target !== "cursorColor" && target !== "selectionBackground") { json({ error: "Bad target" }, 400); return; }
    if (value && !/^#[0-9a-fA-F]{6}$/.test(value)) { json({ error: "Bad color" }, 400); return; }
    if (value) {
      if (!surgicalSetDefaults({ [target]: value })) {
        const s = ensureDefaults(readSettings());
        s.profiles.defaults[target] = value;
        writeSettings(s);
      }
    } else {
      const s = ensureDefaults(readSettings()); // reset: remove the override (clean re-serialize)
      delete s.profiles.defaults[target];
      writeSettings(s);
    }
    json({ target, value: value || null });
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
      if ((settings.schemes || []).some((s) => s.name === name)) {
        json({ error: "Already installed" }, 400);
        return;
      }
      if (!surgicalPushScheme(theme)) {
        if (!settings.schemes) settings.schemes = [];
        settings.schemes.push(theme);
        writeSettings(settings);
      }
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

// Open the given URL in the OS default browser (best-effort). Set TERMINALIZER_NO_OPEN to disable.
function openBrowser(url) {
  if (process.env.TERMINALIZER_NO_OPEN) return;
  const { exec } = require("child_process");
  let cmd;
  if (process.platform === "win32") cmd = `start "" "${url}"`;
  else if (process.platform === "darwin") cmd = `open "${url}"`;
  else {
    let wsl = false;
    try { wsl = fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch {}
    cmd = wsl ? `cmd.exe /c start "" "${url}"` : `xdg-open "${url}"`; // WSL -> Windows default browser
  }
  exec(cmd, () => {}); // ignore errors; the URL is printed regardless
}

module.exports = {
  slimScheme,
  // rarity / progress / achievements added in later tasks:
};

if (require.main === module) {
  const URL_STR = `http://localhost:${PORT}`;
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use — opening ${URL_STR} (it may already be running).`);
      console.error(`For a separate instance: PORT=8080 the-terminalizer`);
      openBrowser(URL_STR); // likely our own instance — just open it
    } else {
      console.error("Server error:", e.message);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`The Terminalizer running at ${URL_STR}`);
    openBrowser(URL_STR);
  });
}
