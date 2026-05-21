const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(
  "/mnt/c/Users/maram/AppData/Local/Packages",
  "Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"
);
const FAVORITES_PATH = path.join(__dirname, "favorites.json");
const CACHE_PATH = path.join(__dirname, "themes-cache.json");
const PORT = 3456;

// --- Favorites ---
function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_PATH, "utf-8")); }
  catch { return []; }
}
function saveFavorites(favs) {
  fs.writeFileSync(FAVORITES_PATH, JSON.stringify(favs, null, 2), "utf-8");
}

// --- Settings ---
function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
}
function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 4), "utf-8");
}
function getCurrentScheme(settings) {
  return settings.profiles.defaults.colorScheme || "Tokyo Night";
}
function getFont(settings) {
  return settings.profiles.defaults.font || { face: "JetBrainsMono Nerd Font", size: 13, weight: "normal" };
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
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

// --- HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Terminalizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0d0d1a;
      color: #e0e0e0;
    }
    .app {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1.5rem 4rem;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
    }
    h1 { font-size: 1.5rem; color: #fff; margin-bottom: 0.3rem; }
    .subtitle { font-size: 0.85rem; color: #666; }

    /* Terminal Preview */
    .terminal-preview {
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 1.5rem;
      border: 1px solid #2a2a4a;
      font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.82rem;
      line-height: 1.5;
      transition: all 0.3s ease;
    }
    .terminal-titlebar {
      padding: 0.5rem 1rem;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .terminal-dot {
      width: 10px; height: 10px; border-radius: 50%;
    }
    .terminal-titlebar span { margin-left: auto; font-size: 0.7rem; opacity: 0.5; }
    .terminal-body { padding: 1rem 1.2rem; }
    .terminal-body .line { white-space: pre; }

    /* Controls row */
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .btn {
      border: 1px solid #2a2a4a;
      border-radius: 10px;
      padding: 0.65rem 1.3rem;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #7aa2f7, #bb9af7);
      color: #1a1b26;
      border: none;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(122,162,247,0.3);
    }
    .btn-secondary {
      background: #1a1a2e;
      color: #ccc;
    }
    .btn-secondary:hover { border-color: #7aa2f7; color: #fff; }
    .btn-secondary.active {
      border-color: #bb9af7;
      color: #bb9af7;
      background: #1e1e35;
    }

    /* Font size */
    .font-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }
    .font-controls label {
      font-size: 0.7rem; color: #555; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .size-btn {
      background: #1a1a2e; border: 1px solid #2a2a4a; color: #ccc;
      width: 30px; height: 30px; border-radius: 7px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; transition: all 0.15s;
    }
    .size-btn:hover { border-color: #7aa2f7; color: #fff; }
    .size-display { font-size: 0.85rem; color: #fff; min-width: 24px; text-align: center; }

    /* Shuffle controls */
    .shuffle-row {
      display: flex; align-items: center; gap: 8px;
    }
    .shuffle-select {
      background: #1a1a2e; border: 1px solid #2a2a4a; color: #ccc;
      padding: 0.45rem 0.6rem; border-radius: 7px; font-size: 0.8rem;
      font-family: inherit; cursor: pointer;
    }
    .shuffle-select:focus { outline: none; border-color: #7aa2f7; }

    /* Opacity slider */
    .slider-row {
      display: flex; align-items: center; gap: 8px;
      background: #13131f; border: 1px solid #1e1e35;
      border-radius: 10px; padding: 0.6rem 1rem;
      margin-bottom: 1.5rem;
    }
    .slider-row label {
      font-size: 0.7rem; color: #555; text-transform: uppercase;
      letter-spacing: 0.08em; flex-shrink: 0;
    }
    .slider-row input[type=range] {
      flex: 1; -webkit-appearance: none; appearance: none;
      height: 4px; background: #2a2a4a; border-radius: 2px; outline: none;
    }
    .slider-row input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 16px; height: 16px;
      border-radius: 50%; background: linear-gradient(135deg, #7aa2f7, #bb9af7);
      cursor: pointer; border: none;
    }
    .slider-row .slider-value {
      font-size: 0.8rem; color: #fff; min-width: 36px; text-align: right;
    }

    /* Tabs */
    .tabs {
      display: flex; gap: 4px; margin-bottom: 1rem;
      border-bottom: 1px solid #1e1e35;
      padding-bottom: 0;
    }
    .tab {
      background: none; border: none; color: #555; padding: 0.6rem 1rem;
      font-size: 0.8rem; cursor: pointer; font-family: inherit;
      border-bottom: 2px solid transparent; transition: all 0.15s;
    }
    .tab:hover { color: #aaa; }
    .tab.active { color: #c0caf5; border-bottom-color: #7aa2f7; }
    .tab .count {
      background: #2a2a4a; color: #888; font-size: 0.65rem;
      padding: 1px 6px; border-radius: 8px; margin-left: 5px;
    }
    .tab.active .count { background: #2d3566; color: #7aa2f7; }

    /* Search */
    .search-bar {
      width: 100%;
      background: #12121f;
      border: 1px solid #2a2a4a;
      color: #e0e0e0;
      padding: 0.6rem 1rem;
      border-radius: 10px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      font-family: inherit;
    }
    .search-bar:focus { outline: none; border-color: #7aa2f7; }
    .search-bar::placeholder { color: #444; }

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
    .scheme-grid::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 4px; }

    .scheme-card {
      background: #13131f;
      border: 1px solid #1e1e35;
      border-radius: 10px;
      padding: 0.7rem 0.9rem;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .scheme-card:hover { border-color: #3a3a6a; background: #18182a; }
    .scheme-card.active { border-color: #7aa2f7; background: #1a1a35; }

    .scheme-colors {
      display: flex; gap: 3px; flex-shrink: 0;
    }
    .scheme-colors .c {
      width: 14px; height: 14px; border-radius: 4px;
    }
    .scheme-name {
      font-size: 0.78rem; color: #aaa; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .scheme-card.active .scheme-name { color: #fff; }
    .scheme-card:hover .scheme-name { color: #ddd; }

    .fav-btn {
      background: none; border: none; cursor: pointer;
      font-size: 0.9rem; padding: 2px; transition: all 0.15s;
      opacity: 0.3; flex-shrink: 0;
    }
    .fav-btn:hover { opacity: 0.7; transform: scale(1.2); }
    .fav-btn.favorited { opacity: 1; }

    .install-btn {
      background: #1e1e35; border: 1px solid #2a2a4a; color: #7aa2f7;
      font-size: 0.65rem; padding: 3px 8px; border-radius: 5px;
      cursor: pointer; flex-shrink: 0; font-family: inherit;
      transition: all 0.15s;
    }
    .install-btn:hover { background: #252550; border-color: #7aa2f7; }

    /* Loading */
    .loading { text-align: center; padding: 2rem; color: #555; font-size: 0.85rem; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #333; border-top-color: #7aa2f7; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Toast */
    .toast {
      position: fixed; bottom: 2rem; left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #bb9af7; color: #1a1b26;
      padding: 0.6rem 1.4rem; border-radius: 10px;
      font-weight: 600; font-size: 0.8rem;
      transition: transform 0.3s ease; pointer-events: none;
      z-index: 100;
    }
    .toast.show { transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>
<div class="app">
  <header>
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
  </div>

  <!-- Controls -->
  <div class="controls">
    <button class="btn btn-primary" onclick="randomize()">Randomize</button>
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

  <input class="search-bar" id="search" placeholder="Search themes..." oninput="renderGrid()">

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
  let shuffleActive = false;
  let shuffleFavsOnly = false;
  let currentOpacity = 95;
  let externalLoaded = false;
  let opacityTimer = null;

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

    body.innerHTML =
      '<div class="line"><span style="color:' + s.green + '">maram@dev</span>' +
      '<span style="color:' + s.foreground + '">:</span>' +
      '<span style="color:' + s.blue + '">~/projects</span>' +
      '<span style="color:' + s.foreground + '">$ </span>' +
      '<span style="color:' + s.foreground + '">node server.js</span></div>' +
      '<div class="line"><span style="color:' + s.cyan + '">INFO</span>' +
      '<span style="color:' + s.foreground + '">  Server running on port </span>' +
      '<span style="color:' + s.yellow + '">3456</span></div>' +
      '<div class="line"><span style="color:' + s.green + '">OK</span>' +
      '<span style="color:' + s.foreground + '">    Loaded </span>' +
      '<span style="color:' + s.purple + '">12 routes</span></div>' +
      '<div class="line"><span style="color:' + s.red + '">WARN</span>' +
      '<span style="color:' + s.foreground + '">  No .env file found, using defaults</span></div>' +
      '<div class="line"><span style="color:' + s.green + '">maram@dev</span>' +
      '<span style="color:' + s.foreground + '">:</span>' +
      '<span style="color:' + s.blue + '">~/projects</span>' +
      '<span style="color:' + s.yellow + '"> (main) </span>' +
      '<span style="color:' + s.foreground + '">$ </span>' +
      '<span style="color:' + s.foreground + '; opacity: 0.4">_</span></div>';
  }

  function renderGrid() {
    const query = document.getElementById("search").value.toLowerCase();
    const grid = document.getElementById("scheme-grid");
    let items = [];

    if (activeTab === "installed") {
      items = installedSchemes
        .filter(s => s.name.toLowerCase().includes(query))
        .map(s => schemeCard(s, true));
    } else if (activeTab === "favorites") {
      items = installedSchemes
        .filter(s => favorites.includes(s.name) && s.name.toLowerCase().includes(query))
        .map(s => schemeCard(s, true));
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

  function schemeCard(s, installed) {
    const isActive = s.name === currentScheme ? " active" : "";
    const isFav = favorites.includes(s.name);
    const safeName = s.name.replace(/'/g, "\\\\'");
    const colors = [s.red, s.green, s.blue, s.yellow, s.purple, s.cyan].filter(Boolean);
    return '<div class="scheme-card' + isActive + '" onclick="pickScheme(\\'' + safeName + '\\')">' +
      '<div class="scheme-colors">' + colors.map(c => '<div class="c" style="background:' + c + '"></div>').join("") + '</div>' +
      '<div class="scheme-name">' + s.name + '</div>' +
      '<button class="fav-btn' + (isFav ? ' favorited' : '') + '" onclick="event.stopPropagation();toggleFav(\\'' + safeName + '\\')">' +
      (isFav ? "&#9733;" : "&#9734;") + '</button></div>';
  }

  function externalCard(t) {
    const safeName = t.name.replace(/'/g, "\\\\'");
    const safeUrl = t.download_url.replace(/'/g, "\\\\'");
    return '<div class="scheme-card">' +
      '<div class="scheme-name">' + t.name + '</div>' +
      '<button class="install-btn" onclick="event.stopPropagation();installTheme(\\'' + safeName + '\\',\\'' + safeUrl + '\\')">+ Install</button></div>';
  }

  async function loadExternal() {
    const res = await fetch("/api/external-index");
    externalIndex = await res.json();
    externalLoaded = true;
    document.getElementById("explore-count").textContent = externalIndex.length;
    renderGrid();
  }

  async function randomize() {
    const res = await fetch("/api/randomize", { method: "POST" });
    const data = await res.json();
    currentScheme = data.scheme;
    const existing = installedSchemes.find(s => s.name === data.scheme);
    if (existing) { renderPreview(); renderGrid(); }
    showToast("Switched to " + data.scheme);
  }

  async function pickScheme(name) {
    const res = await fetch("/api/set-scheme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    currentScheme = data.scheme;
    renderPreview();
    renderGrid();
    showToast(data.scheme);
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
  }

  async function installTheme(name, url) {
    const btn = event.target;
    btn.textContent = "...";
    btn.disabled = true;
    const res = await fetch("/api/install-theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url })
    });
    const data = await res.json();
    if (data.scheme) {
      installedSchemes.push(data.scheme);
      document.getElementById("installed-count").textContent = installedSchemes.length;
      renderGrid();
      showToast("Installed " + name);
    }
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

  // Poll for shuffle changes
  setInterval(async () => {
    if (!shuffleActive) return;
    const res = await fetch("/api/current");
    const data = await res.json();
    if (data.current !== currentScheme) {
      currentScheme = data.current;
      renderPreview();
      renderGrid();
    }
  }, 5000);

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

  if (route === "GET /") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (route === "GET /api/state") {
    const settings = readSettings();
    const schemes = settings.schemes.map((s) => ({
      name: s.name, background: s.background, foreground: s.foreground,
      red: s.red, green: s.green, blue: s.blue, yellow: s.yellow,
      purple: s.purple, cyan: s.cyan, brightBlack: s.brightBlack,
    }));
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
      const theme = await fetchExternalTheme(themeUrl);
      if (!theme) { json({ error: "Failed to fetch" }, 500); return; }
      const settings = readSettings();
      if (settings.schemes.some((s) => s.name === name)) {
        json({ error: "Already installed" }, 400);
        return;
      }
      settings.schemes.push(theme);
      writeSettings(settings);
      json({
        scheme: {
          name: theme.name, background: theme.background, foreground: theme.foreground,
          red: theme.red, green: theme.green, blue: theme.blue, yellow: theme.yellow,
          purple: theme.purple, cyan: theme.cyan, brightBlack: theme.brightBlack,
        },
      });
    } catch (e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`The Terminalizer running at http://localhost:${PORT}`);
});
