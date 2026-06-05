# The Terminalizer "Reactor" Game-Feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer cyberpunk game-feel onto The Terminalizer — a juicy "reactor" randomize spin, synthesized sound, a collection/progression meta (discovered counter, rarity tiers, achievements, XP), and HUD/boot chrome — without losing its existing Daft Punk aesthetic or single-file architecture.

**Architecture:** Everything stays in the single `server.js` (Node stdlib server + embedded HTML/CSS/JS). New *pure logic* (rarity scoring, progress persistence, achievements, XP) is added as exported, side-effect-free functions near the existing helpers, so it is unit-testable with Node's built-in `node:test`. The server bootstrap is made `require`-safe so tests can import those functions without starting the HTTP server. New user state persists to `~/.terminalizer/progress.json` via the existing atomic-write pattern. Visual/audio layers are client-side and verified by driving the running app.

**Tech Stack:** Node.js (stdlib `http`/`fs` — no new runtime deps), `node:test` + `node:assert` for tests (built-in, zero deps), Web Audio API + DOM for client game-feel.

---

## Refinements vs. the approved spec (read first)

Two deliberate, plan-time refinements. Flag with the user if either is unwanted:

1. **Rarity is computed server-side, not client-side.** The spec said client-side. Moving it to the server (a) makes it a pure, unit-testable function and (b) lets achievements like "applied a Legendary" be evaluated from trusted server state instead of client-supplied tiers. Each scheme in `GET /api/state` gains a `rarity` string; the client just reads `s.rarity`. Same user-visible result.
2. **Achievement set trimmed to 6**, all evaluable from server state at discover/favorite time (see Task 5). The spec's "ran auto-shuffle" example is **cut** (YAGNI — it would need a separate event channel for one badge). Everything else from the spec stays.

## File structure

- **`server.js`** (modify) — all production code stays here, per the single-file constraint. New sections:
  - Pure logic block (rarity, progress, achievements, XP) added after `slimScheme` (~line 294).
  - `require.main` guard around `server.listen`/`openBrowser` (~line 1760) so importing the file for tests is side-effect-free.
  - `module.exports` of the pure functions at the end of the Node section.
  - New routes (`GET /api/progress`, `POST /api/progress/discover`) before the 404 (~line 1732).
  - `/api/state` augmented to include per-scheme `rarity` and the full `progress` object.
  - Embedded client: new CSS before `</style>` (~line 930), new markup in `<header>`/controls (~line 951), new JS (reel, audio, boot, HUD, progress) in the `<script>` (~line 1047).
- **`test/logic.test.js`** (create) — `node:test` unit tests for the pure logic. NOT added to `package.json` `files`, so it is never published to npm.
- **`package.json`** (modify) — add `"test": "node --test"` script; bump version.
- **`README.md`** (modify) — document new features (only because README already exists and lists features; not a new doc file).

## Testing approach

- **Pure server logic (rarity, progress, achievements, XP):** strict TDD with `node:test`. These functions take explicit inputs (and progress functions take an optional path arg) so tests use temp files and never touch real user state.
- **Visual/audio/UI (reel, sound, boot, HUD, badges):** no browser test harness exists and adding one is out of scope. These are verified by **driving the running app** (`node server.js` → interact → observe), with explicit expected observations in each task. Set `TERMINALIZER_NO_OPEN=1` when launching during development to avoid spawning browser tabs.

## Shared contracts (used across tasks — keep names exact)

```js
// Rarity
const RARITY_TIERS = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
function rarityScore(scheme) -> number   // 0..100, deterministic
function rarityTier(scheme) -> string    // one of RARITY_TIERS

// Progress persistence
function defaultProgress() -> { discovered: [], achievements: [], xp: 0 }
function loadProgress(p = PROGRESS_PATH) -> progress
function saveProgress(progress, p = PROGRESS_PATH) -> void

// XP / level
function levelForXp(xp) -> number        // 1-based

// Achievements
const ACHIEVEMENTS = [ { id, label, test(progress, ctx) -> bool }, ... ]
// ctx = { totalSchemes, favoritesCount, lastTier, lastBrightness, now }
function evaluateAchievements(progress, ctx) -> [{ id, label }]  // newly unlocked; mutates progress.achievements
```

---

## Task 1: Make `server.js` require-safe + add test harness

**Files:**
- Modify: `server.js` (bootstrap guard near `server.listen` ~1760; add `module.exports` at end of Node section ~1742)
- Modify: `package.json` (add `test` script)
- Create: `test/smoke.test.js`

- [ ] **Step 1: Add the test script to `package.json`**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Guard the server bootstrap so `require` doesn't start it**

In `server.js`, find (near line 1760):

```js
const URL_STR = `http://localhost:${PORT}`;
server.on("error", (e) => {
```

Wrap everything from `const URL_STR` through the final `server.listen(...)` block in a `require.main` guard. Replace:

```js
const URL_STR = `http://localhost:${PORT}`;
server.on("error", (e) => {
```

with:

```js
const URL_STR = `http://localhost:${PORT}`;
if (require.main === module) {
server.on("error", (e) => {
```

Then find the closing of the `server.listen` callback at the very end of the Node section:

```js
server.listen(PORT, HOST, () => {
  console.log(`The Terminalizer running at ${URL_STR}`);
  openBrowser(URL_STR);
});
```

and add a closing brace for the guard right after it:

```js
server.listen(PORT, HOST, () => {
  console.log(`The Terminalizer running at ${URL_STR}`);
  openBrowser(URL_STR);
});
}
```

> Note: the original last line is `});` closing `server.listen`; confirm the file currently ends the Node portion there before adding the extra `}`. The `HTML` constant and all functions are defined above this guard and remain importable.

- [ ] **Step 3: Export the functions tests will need (placeholder set for now)**

In `server.js`, immediately BEFORE the `const URL_STR` line added in Step 2, add:

```js
module.exports = {
  slimScheme,
  // rarity / progress / achievements added in later tasks:
};
```

- [ ] **Step 4: Write a smoke test proving import is side-effect-free**

Create `test/smoke.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");

// Point at a throwaway settings path so findSettingsPath() is never invoked,
// and never open a browser / bind a port on import.
process.env.TERMINAL_SETTINGS_PATH = process.env.TERMINAL_SETTINGS_PATH || __filename;
process.env.TERMINALIZER_NO_OPEN = "1";

const mod = require("../server.js");

test("server.js can be imported without starting the server", () => {
  assert.strictEqual(typeof mod.slimScheme, "function");
});

test("slimScheme keeps name + known keys only", () => {
  const out = mod.slimScheme({ name: "X", red: "#ff0000", bogus: "nope" });
  assert.strictEqual(out.name, "X");
  assert.strictEqual(out.red, "#ff0000");
  assert.strictEqual(out.bogus, undefined);
});
```

- [ ] **Step 5: Run the test, expect PASS**

Run: `npm test`
Expected: 2 tests pass, process exits cleanly (no "running at http://..." line, no hung port).

- [ ] **Step 6: Commit**

```bash
git add server.js package.json test/smoke.test.js
git commit -m "test: make server.js require-safe and add node:test harness"
```

---

## Task 2: Rarity scoring (server, TDD) + expose in `/api/state`

**Files:**
- Modify: `server.js` (add pure rarity functions after `slimScheme` ~line 294; export them; use in `/api/state` ~line 1586)
- Modify: `test/logic.test.js` (create)

- [ ] **Step 1: Write failing tests for rarity helpers**

Create `test/logic.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
process.env.TERMINAL_SETTINGS_PATH = process.env.TERMINAL_SETTINGS_PATH || __filename;
process.env.TERMINALIZER_NO_OPEN = "1";
const m = require("../server.js");

// A vivid, diverse palette should outscore a flat grayscale one.
const vivid = {
  name: "Vivid", background: "#0b0e14", foreground: "#e6e6e6",
  red: "#ff2d55", green: "#2dff88", yellow: "#ffd400", blue: "#2d6bff",
  purple: "#b02dff", cyan: "#2dffea", white: "#ffffff", black: "#000000",
};
const gray = {
  name: "Gray", background: "#1a1a1a", foreground: "#bdbdbd",
  red: "#555555", green: "#5a5a5a", yellow: "#606060", blue: "#505050",
  purple: "#585858", cyan: "#5c5c5c", white: "#cccccc", black: "#202020",
};

test("rarityScore is in 0..100 and deterministic", () => {
  const a = m.rarityScore(vivid);
  assert.ok(a >= 0 && a <= 100);
  assert.strictEqual(a, m.rarityScore(vivid)); // deterministic
});

test("vivid palette scores higher than grayscale", () => {
  assert.ok(m.rarityScore(vivid) > m.rarityScore(gray));
});

test("rarityTier returns a known tier", () => {
  assert.ok(m.RARITY_TIERS.includes(m.rarityTier(vivid)));
  assert.ok(m.RARITY_TIERS.includes(m.rarityTier(gray)));
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test`
Expected: FAIL — `m.rarityScore is not a function`.

- [ ] **Step 3: Implement rarity helpers in `server.js`**

In `server.js`, AFTER the `slimScheme` function (line ~294), add:

```js
// --- Rarity (deterministic, derived from a scheme's palette) ---
const RARITY_TIERS = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length < 6) return null;
  return {
    r: parseInt(h.substr(0, 2), 16) || 0,
    g: parseInt(h.substr(2, 2), 16) || 0,
    b: parseInt(h.substr(4, 2), 16) || 0,
  };
}
function rgbBrightness({ r, g, b }) { return (r * 299 + g * 587 + b * 114) / 1000; }
function rgbHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

// Score 0..100 from: average saturation of the 6 ANSI hues, hue diversity
// (distinct 30-degree buckets), and fg/bg contrast.
function rarityScore(scheme) {
  const hueKeys = ["red", "green", "yellow", "blue", "purple", "cyan"];
  const hsls = hueKeys.map((k) => hexToRgb(scheme[k])).filter(Boolean).map(rgbHsl);
  if (hsls.length === 0) return 0;
  const avgSat = hsls.reduce((a, x) => a + x.s, 0) / hsls.length; // 0..1
  const buckets = new Set(hsls.map((x) => Math.round(x.h / 30)));
  const hueDiversity = buckets.size / 6; // 0..1
  const bg = hexToRgb(scheme.background), fg = hexToRgb(scheme.foreground);
  const contrast = bg && fg
    ? Math.min(1, Math.abs(rgbBrightness(fg) - rgbBrightness(bg)) / 255)
    : 0.5;
  const score = 100 * (0.5 * avgSat + 0.35 * hueDiversity + 0.15 * contrast);
  return Math.max(0, Math.min(100, score));
}

function rarityTier(scheme) {
  const s = rarityScore(scheme);
  if (s >= 80) return "Legendary";
  if (s >= 65) return "Epic";
  if (s >= 50) return "Rare";
  if (s >= 32) return "Uncommon";
  return "Common";
}
```

- [ ] **Step 4: Export the new helpers**

In the `module.exports` block, add `RARITY_TIERS`, `rarityScore`, `rarityTier`:

```js
module.exports = {
  slimScheme,
  RARITY_TIERS, rarityScore, rarityTier,
  // progress / achievements added in later tasks:
};
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`
Expected: all rarity tests pass.

- [ ] **Step 6: Attach `rarity` to each scheme in `/api/state`**

In `server.js`, in the `GET /api/state` handler (~line 1586), change:

```js
      schemes: (settings.schemes || []).map(slimScheme),
```

to:

```js
      schemes: (settings.schemes || []).map((s) => {
        const slim = slimScheme(s);
        slim.rarity = rarityTier(s);
        return slim;
      }),
```

- [ ] **Step 7: Tune thresholds against the real 515 palettes**

Run this one-off check (does not modify anything):

```bash
node -e "process.env.TERMINAL_SETTINGS_PATH='%TEMP%\nope';process.env.TERMINALIZER_NO_OPEN=1;const m=require('./server.js');const https=require('https');https.get('https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/windowsterminal/Tokyo%20Night.json',()=>{});const t={};const fs=require('fs');" 2>nul || echo "skip"
```

Simpler/reliable: with the dev server running, fetch state and bucket tiers:

```bash
curl -s http://127.0.0.1:3456/api/state > state.json
node -e "const d=require('./state.json');const c={};d.schemes.forEach(s=>c[s.rarity]=(c[s.rarity]||0)+1);console.log(c, 'Legendary %', ((c.Legendary||0)/d.schemes.length*100).toFixed(1));"
```

Expected: a spread across all five tiers. **Goal:** Legendary ≈ 2–6% of themes. If Legendary is >8% or <1%, adjust the `>= 80` / `>= 65` cutoffs in `rarityTier` and re-check. Delete `state.json` when done.

- [ ] **Step 8: Commit**

```bash
git add server.js test/logic.test.js
git commit -m "feat: deterministic rarity tiers, exposed per-scheme in /api/state"
```

---

## Task 3: Rarity badges in the UI (client, manual verify)

**Files:**
- Modify: `server.js` (CSS before `</style>` ~930; `schemeCard` ~1229; `renderPreview` ~1160)

- [ ] **Step 1: Add rarity badge CSS**

In `server.js`, before `</style>` (~line 930), add:

```css
    /* Rarity badges */
    .rarity { display:inline-flex; align-items:center; gap:4px; font-size:0.62rem; font-weight:700;
      letter-spacing:0.06em; text-transform:uppercase; padding:2px 6px; border-radius:5px;
      border:1px solid currentColor; background:rgba(0,0,0,0.35); }
    .rarity::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor;
      box-shadow:0 0 6px 1px currentColor; }
    .rarity.Common    { color:#9aa3ad; }
    .rarity.Uncommon  { color:#4cd07d; }
    .rarity.Rare      { color:#4aa3ff; }
    .rarity.Epic      { color:#c06bff; }
    .rarity.Legendary { color:#ffcf3f; }
    .card-rarity { position:absolute; left:8px; top:8px; z-index:2; }
```

- [ ] **Step 2: Render a rarity gem on each card**

In `schemeCard` (~line 1229), after the `active-badge` div, insert a rarity gem. Change the return to include it:

```js
    return '<div class="scheme-card' + isActive + '" data-name="' + esc(s.name) + '" style="background:' + esc(bg) + ';">' +
      '<div class="active-badge">&#10003;</div>' +
      (s.rarity ? '<span class="rarity ' + esc(s.rarity) + ' card-rarity" title="' + esc(s.rarity) + '"></span>' : '') +
      '<div class="scheme-colors">' + colors.map(c => '<div class="c" style="background:' + esc(c) + '"></div>').join("") + '</div>' +
      '<div class="scheme-name" style="color:' + esc(fg) + '">' + esc(s.name) + '</div>' +
      '<button class="fav-btn' + (isFav ? ' favorited' : '') + '" data-fav="' + esc(s.name) + '" title="Toggle favorite">' +
      (isFav ? "&#9733;" : "&#9734;") + '</button></div>';
```

> The `.card-rarity` gem shows only the colored dot (no text) to stay compact; the tier name is in the tooltip. The text label is used in the preview panel (next step).

- [ ] **Step 3: Show the rarity label in the preview**

In `renderPreview` (~line 1160), after setting `tp-name`, add a rarity label next to it. First add markup: in the titlebar (`server.js` ~line 964), change:

```html
      <span id="tp-name">Loading...</span>
```

to:

```html
      <span id="tp-name">Loading...</span>
      <span id="tp-rarity" class="rarity" style="margin-left:auto"></span>
```

Then in `renderPreview`, after the `tp-name` lines, add:

```js
    const rEl = document.getElementById("tp-rarity");
    rEl.className = "rarity " + (s.rarity || "Common");
    rEl.textContent = s.rarity || "";
```

- [ ] **Step 4: Manual verification**

Run: `set TERMINALIZER_NO_OPEN=1 && node server.js` (PowerShell: `$env:TERMINALIZER_NO_OPEN=1; node server.js`), open `http://localhost:3456`.
Expected observations:
- Each grid card shows a small glowing colored dot top-left; hovering shows the tier name.
- The preview titlebar shows a tier pill (e.g. "Legendary" in gold) for the current theme.
- Switching themes updates the preview tier pill.
- Tier colors: grey/green/blue/purple/gold for Common→Legendary.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: rarity badges on theme cards and preview"
```

---

## Task 4: Progress persistence + endpoints (server, TDD)

**Files:**
- Modify: `server.js` (add `PROGRESS_PATH` ~line 37; progress functions after rarity block; routes before 404 ~1732; export)
- Modify: `test/logic.test.js`

- [ ] **Step 1: Write failing tests for progress persistence**

Append to `test/logic.test.js`:

```js
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function tmpProgress() {
  return path.join(os.tmpdir(), "tz-progress-" + process.hrtime.bigint() + ".json");
}

test("defaultProgress shape", () => {
  const p = m.defaultProgress();
  assert.deepStrictEqual(p, { discovered: [], achievements: [], xp: 0 });
});

test("loadProgress returns defaults when file missing", () => {
  const p = tmpProgress();
  assert.deepStrictEqual(m.loadProgress(p), m.defaultProgress());
});

test("saveProgress then loadProgress round-trips", () => {
  const p = tmpProgress();
  const data = { discovered: ["A", "B"], achievements: [], xp: 20 };
  m.saveProgress(data, p);
  assert.deepStrictEqual(m.loadProgress(p), data);
  fs.unlinkSync(p);
});

test("loadProgress tolerates corrupt JSON", () => {
  const p = tmpProgress();
  fs.writeFileSync(p, "{ not json", "utf-8");
  assert.deepStrictEqual(m.loadProgress(p), m.defaultProgress());
  fs.unlinkSync(p);
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test`
Expected: FAIL — `m.defaultProgress is not a function`.

- [ ] **Step 3: Add `PROGRESS_PATH` constant**

In `server.js`, after `const CACHE_PATH = ...` (~line 37), add:

```js
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
```

- [ ] **Step 4: Implement progress functions**

In `server.js`, after the rarity block (end of Task 2's code), add:

```js
// --- Progress (collection meta) ---
function defaultProgress() { return { discovered: [], achievements: [], xp: 0 }; }

function loadProgress(p = PROGRESS_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      discovered: Array.isArray(data.discovered) ? data.discovered : [],
      achievements: Array.isArray(data.achievements) ? data.achievements : [],
      xp: typeof data.xp === "number" ? data.xp : 0,
    };
  } catch { return defaultProgress(); }
}

// Atomic write (temp + rename) so a crash can't corrupt progress.json.
function saveProgress(progress, p = PROGRESS_PATH) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}
```

- [ ] **Step 5: Export progress functions**

Add `defaultProgress, loadProgress, saveProgress` to `module.exports`.

- [ ] **Step 6: Run tests, expect PASS**

Run: `npm test`
Expected: all progress persistence tests pass.

- [ ] **Step 7: Add `GET /api/progress` and `POST /api/progress/discover` routes**

In `server.js`, BEFORE the `res.writeHead(404)` line (~line 1733), add:

```js
  if (route === "GET /api/progress") {
    json({ progress: loadProgress() });
    return;
  }

  if (route === "POST /api/progress/discover") {
    const { name } = await parseBody(req);
    const settings = readSettings();
    const scheme = (settings.schemes || []).find((s) => s.name === name);
    if (!scheme) { json({ error: "Unknown scheme" }, 400); return; }
    const progress = loadProgress();
    const isNew = !progress.discovered.includes(name);
    if (isNew) { progress.discovered.push(name); progress.xp += 10; }
    const tier = rarityTier(scheme);
    const bg = hexToRgb(scheme.background);
    const ctx = {
      totalSchemes: (settings.schemes || []).length,
      favoritesCount: loadFavorites().length,
      lastTier: tier,
      lastBrightness: bg ? rgbBrightness(bg) : null,
    };
    const newlyUnlocked = evaluateAchievements(progress, ctx);
    saveProgress(progress);
    json({ progress, newlyUnlocked, tier, isNew });
    return;
  }
```

> `evaluateAchievements` is implemented in Task 5; this route depends on it. If executing strictly in order, implement Task 5's function before testing this route end-to-end.

- [ ] **Step 8: Include `progress` in `/api/state`**

In the `GET /api/state` response object (~line 1586), add a `progress` field:

```js
      overrides: { cursorColor: defaults.cursorColor || null, selectionBackground: defaults.selectionBackground || null },
      progress: loadProgress(),
```

- [ ] **Step 9: Commit**

```bash
git add server.js test/logic.test.js
git commit -m "feat: progress.json persistence + /api/progress endpoints"
```

---

## Task 5: XP/level + achievements (server, TDD)

**Files:**
- Modify: `server.js` (add `levelForXp`, `ACHIEVEMENTS`, `evaluateAchievements` after progress block; award favorite XP in toggle-favorite route ~1642; export)
- Modify: `test/logic.test.js`

- [ ] **Step 1: Write failing tests for level + achievements**

Append to `test/logic.test.js`:

```js
test("levelForXp", () => {
  assert.strictEqual(m.levelForXp(0), 1);
  assert.strictEqual(m.levelForXp(99), 1);
  assert.strictEqual(m.levelForXp(100), 2);
  assert.strictEqual(m.levelForXp(250), 3);
});

test("evaluateAchievements unlocks discover_10 once at 10 discoveries", () => {
  const p = { discovered: Array.from({ length: 10 }, (_, i) => "t" + i), achievements: [], xp: 0 };
  const ctx = { totalSchemes: 500, favoritesCount: 0, lastTier: "Common", lastBrightness: 100, now: 1 };
  const first = m.evaluateAchievements(p, ctx);
  assert.ok(first.some((a) => a.id === "discover_10"));
  assert.ok(p.achievements.some((a) => a.id === "discover_10"));
  // idempotent: re-evaluating does not re-unlock
  const second = m.evaluateAchievements(p, ctx);
  assert.ok(!second.some((a) => a.id === "discover_10"));
});

test("evaluateAchievements unlocks apply_legendary and apply_brutal by context", () => {
  const p = m.defaultProgress();
  const leg = m.evaluateAchievements(p, { totalSchemes: 500, favoritesCount: 0, lastTier: "Legendary", lastBrightness: 100, now: 1 });
  assert.ok(leg.some((a) => a.id === "apply_legendary"));
  const brutal = m.evaluateAchievements(p, { totalSchemes: 500, favoritesCount: 0, lastTier: "Common", lastBrightness: 5, now: 1 });
  assert.ok(brutal.some((a) => a.id === "apply_brutal"));
});

test("evaluateAchievements unlocks fav_10 from favoritesCount", () => {
  const p = m.defaultProgress();
  const out = m.evaluateAchievements(p, { totalSchemes: 500, favoritesCount: 10, lastTier: null, lastBrightness: null, now: 1 });
  assert.ok(out.some((a) => a.id === "fav_10"));
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test`
Expected: FAIL — `m.levelForXp is not a function`.

- [ ] **Step 3: Implement level + achievements**

In `server.js`, after the progress block (end of Task 4's code), add:

```js
// --- XP / level ---
function levelForXp(xp) { return Math.floor((xp || 0) / 100) + 1; }

// --- Achievements (all evaluable from server state) ---
const ACHIEVEMENTS = [
  { id: "discover_10",     label: "Scout — 10 themes discovered",        test: (p) => p.discovered.length >= 10 },
  { id: "discover_100",    label: "Archivist — 100 themes discovered",   test: (p) => p.discovered.length >= 100 },
  { id: "discover_all",    label: "Completionist — every theme found",   test: (p, c) => c.totalSchemes > 0 && p.discovered.length >= c.totalSchemes },
  { id: "fav_10",          label: "Curator — 10 favorites",              test: (p, c) => c.favoritesCount >= 10 },
  { id: "apply_legendary", label: "Legendary — applied a Legendary palette", test: (p, c) => c.lastTier === "Legendary" },
  { id: "apply_brutal",    label: "Into the Void — applied a near-black palette", test: (p, c) => typeof c.lastBrightness === "number" && c.lastBrightness < 12 },
];

// Mutates progress.achievements; returns the newly-unlocked {id,label} list.
function evaluateAchievements(progress, ctx) {
  const now = (ctx && ctx.now) || Date.now();
  const have = new Set(progress.achievements.map((a) => a.id));
  const newly = [];
  for (const def of ACHIEVEMENTS) {
    if (have.has(def.id)) continue;
    if (def.test(progress, ctx || {})) {
      progress.achievements.push({ id: def.id, unlockedAt: now });
      newly.push({ id: def.id, label: def.label });
    }
  }
  return newly;
}
```

- [ ] **Step 4: Export them**

Add `levelForXp, ACHIEVEMENTS, evaluateAchievements` to `module.exports`.

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test`
Expected: all level + achievement tests pass.

- [ ] **Step 6: Award favorite XP + evaluate achievements in the toggle-favorite route**

In `server.js`, replace the `POST /api/toggle-favorite` handler (~line 1642) with:

```js
  if (route === "POST /api/toggle-favorite") {
    const { name } = await parseBody(req);
    const favs = loadFavorites();
    const idx = favs.indexOf(name);
    const added = idx < 0;
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(name);
    saveFavorites(favs);
    const progress = loadProgress();
    if (added) progress.xp += 5;
    const newlyUnlocked = evaluateAchievements(progress, {
      totalSchemes: (readSettings().schemes || []).length,
      favoritesCount: favs.length,
      lastTier: null, lastBrightness: null,
    });
    saveProgress(progress);
    json({ favorites: favs, progress, newlyUnlocked });
    return;
  }
```

- [ ] **Step 7: Verify the discover route end-to-end (now that achievements exist)**

Run: `$env:TERMINALIZER_NO_OPEN=1; node server.js` in one shell. In another:

```bash
curl -s -X POST http://127.0.0.1:3456/api/progress/discover -H "Content-Type: application/json" -d "{\"name\":\"Tokyo Night\"}"
```

Expected: JSON with `progress.discovered` containing `"Tokyo Night"`, `progress.xp` ≥ 10, a `tier`, `isNew:true`. Run the same curl again → `isNew:false`, xp unchanged. Confirm `~/.terminalizer/progress.json` now exists.

- [ ] **Step 8: Commit**

```bash
git add server.js test/logic.test.js
git commit -m "feat: XP/level + achievement evaluation on discover and favorite"
```

---

## Task 6: Wire progress into the client (HUD counter, discovery, achievement toasts)

**Files:**
- Modify: `server.js` (client state ~1048; `fetchState` ~1121; `pickScheme`/`randomize`/`undoTheme`/`redoTheme` discover calls; new `discover` + `applyProgress` + `achievementToast` helpers; HUD markup ~951)

- [ ] **Step 1: Add the HUD status strip markup**

In `server.js`, inside `<header>` (~line 955), after the `red-scanner` div, add:

```html
    <div class="hud-strip" id="hud-strip" aria-live="polite">
      <span class="hud-stat" title="Themes discovered">◈ <b id="hud-discovered">0</b><span class="hud-sub"> / <span id="hud-total">0</span></span></span>
      <span class="hud-stat" title="Level">LVL <b id="hud-level">1</b></span>
      <span class="hud-stat" id="hud-xp" title="XP">XP <b id="hud-xp-val">0</b></span>
      <button class="hud-sound" id="sound-toggle" title="Toggle sound" onclick="toggleSound()">♪</button>
    </div>
```

- [ ] **Step 2: Add HUD strip CSS**

Before `</style>` (~line 930), add:

```css
    .hud-strip { display:flex; gap:14px; align-items:center; justify-content:center; margin-top:0.85rem;
      font-family:'JetBrains Mono', monospace; font-size:0.72rem; color:var(--text-dim); flex-wrap:wrap; }
    .hud-stat { display:inline-flex; gap:4px; align-items:center; padding:3px 9px; border-radius:6px;
      border:1px solid var(--border); background:var(--surface-2); }
    .hud-stat b { color:var(--accent); font-weight:700; }
    .hud-sub { color:var(--text-faint); }
    .hud-sound { cursor:pointer; border:1px solid var(--border); background:var(--surface-2);
      color:var(--accent); border-radius:6px; padding:3px 9px; font-size:0.8rem; line-height:1; }
    .hud-sound.muted { color:var(--text-ghost); }
```

- [ ] **Step 3: Add client progress state + helpers**

In the `<script>` state block (~line 1063, after `let applyAll = false;`), add:

```js
  let progress = { discovered: [], achievements: [], xp: 0 };
  let totalSchemes = 0;
```

Then add these functions near `showToast` (~line 1500):

```js
  function levelFromXp(xp) { return Math.floor((xp || 0) / 100) + 1; }

  function applyProgress(p) {
    if (!p) return;
    progress = p;
    document.getElementById("hud-discovered").textContent = progress.discovered.length;
    document.getElementById("hud-total").textContent = totalSchemes;
    document.getElementById("hud-level").textContent = levelFromXp(progress.xp);
    document.getElementById("hud-xp-val").textContent = progress.xp;
  }

  function achievementToast(list) {
    if (!list || !list.length) return;
    list.forEach((a, i) => setTimeout(() => {
      showToast("🏆 " + a.label);
      if (window.sfx) sfx.achievement();
    }, i * 1200));
  }

  // Mark a theme discovered server-side; updates HUD + fires achievement toasts.
  async function discover(name) {
    try {
      const res = await fetch("/api/progress/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.error) return;
      applyProgress(data.progress);
      achievementToast(data.newlyUnlocked);
    } catch (e) {}
  }
```

> `window.sfx` is defined in Task 8; the `if (window.sfx)` guard keeps this safe until then.

- [ ] **Step 4: Load progress + total in `fetchState`**

In `fetchState` (~line 1121), after `installedSchemes = data.schemes;` add:

```js
    totalSchemes = data.schemes.length;
```

and near the end of `fetchState` (before `renderPreview()`), add:

```js
    applyProgress(data.progress);
    discover(currentScheme);
```

- [ ] **Step 5: Call `discover` whenever a theme becomes current**

In `pickScheme` (~line 1290), after `currentScheme = data.scheme;` add `discover(currentScheme);`.
In `randomize` (~line 1280), after `currentScheme = data.scheme;` add `discover(currentScheme);`.
In `undoTheme` and `redoTheme`, after `currentScheme = name;` add `discover(name);`.
In the shuffle poll `setInterval` (~line 1522), after `currentScheme = data.current;` add `discover(currentScheme);`.

- [ ] **Step 6: Use the favorite response's progress + achievements**

In `toggleFav` (~line 1342), after `favorites = data.favorites;` add:

```js
    if (data.progress) applyProgress(data.progress);
    achievementToast(data.newlyUnlocked);
```

- [ ] **Step 7: Manual verification**

Run the app. Expected:
- HUD strip shows `◈ N / 515`, `LVL x`, `XP y`.
- Applying/randomizing a new theme increments discovered + XP within ~1s.
- Favoriting 10 themes pops a "🏆 Curator" toast.
- Reload → HUD reflects persisted progress (counts don't reset).

- [ ] **Step 8: Commit**

```bash
git add server.js
git commit -m "feat: client HUD strip, discovery tracking, achievement toasts"
```

---

## Task 7: The Reactor spin (client, manual verify)

**Files:**
- Modify: `server.js` (reel CSS ~930; reel overlay markup in preview ~959; `runReactor` function; `randomize` to route through it; reduced-motion handling)

- [ ] **Step 1: Add reel overlay markup**

In `server.js`, inside `.terminal-preview` (~line 959), after the `palette-strip` div, add:

```html
    <div class="reactor-overlay" id="reactor-overlay" aria-hidden="true">
      <div class="reactor-reel" id="reactor-reel"></div>
      <div class="reactor-flash" id="reactor-flash"></div>
    </div>
```

- [ ] **Step 2: Add reactor CSS**

Before `</style>` (~line 930), add:

```css
    .reactor-overlay { position:absolute; inset:0; pointer-events:none; overflow:hidden;
      border-radius:inherit; opacity:0; transition:opacity 0.15s; z-index:5; }
    .reactor-overlay.spinning { opacity:1; }
    .reactor-reel { position:absolute; left:0; right:0; top:50%; transform:translateY(-50%);
      text-align:center; font-family:'JetBrains Mono', monospace; font-weight:700;
      font-size:1.1rem; color:var(--accent); text-shadow:0 0 12px var(--accent);
      white-space:nowrap; filter:blur(0.4px); }
    .reactor-flash { position:absolute; inset:0; background:radial-gradient(circle at 50% 50%, var(--accent-soft), transparent 60%);
      opacity:0; }
    @keyframes reactor-burst { 0%{opacity:0;transform:scale(0.6);} 30%{opacity:0.85;} 100%{opacity:0;transform:scale(1.5);} }
    .reactor-flash.burst { animation:reactor-burst 0.5s ease-out; }
    .reactor-overlay.lock .reactor-reel { animation:reactor-lock 0.32s cubic-bezier(.2,1.4,.3,1); }
    @keyframes reactor-lock { 0%{transform:translateY(-50%) scale(1.25);} 100%{transform:translateY(-50%) scale(1);} }
    @media (prefers-reduced-motion: reduce) { .reactor-overlay { display:none; } }
```

- [ ] **Step 3: Implement `runReactor` + reduced-motion guard**

In the `<script>`, near `randomize` (~line 1280), add:

```js
  let reactorBusy = false;
  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Animate a slot-reel that decelerates to `finalName`, then call onLock().
  function runReactor(finalName, tier, onLock) {
    const overlay = document.getElementById("reactor-overlay");
    const reel = document.getElementById("reactor-reel");
    const flash = document.getElementById("reactor-flash");
    if (prefersReducedMotion()) { onLock(); return; }
    reactorBusy = true;
    overlay.classList.add("spinning");
    overlay.classList.remove("lock");
    const names = installedSchemes.map(s => s.name);
    let t = 0;                 // 0..1 progress
    let delay = 40;            // ms between ticks, grows as it decelerates
    const pool = names.length ? names : [finalName];
    function tick() {
      if (t >= 1) { return lock(); }
      reel.textContent = pool[Math.floor(Math.random() * pool.length)];
      if (window.sfx) sfx.tick();
      t += 0.05 + t * 0.04;    // accelerate progress => fewer, slower ticks near end
      delay = 40 + t * 220;    // decelerate
      setTimeout(tick, delay);
    }
    function lock() {
      reel.textContent = finalName;
      overlay.classList.add("lock");
      flash.classList.remove("burst"); void flash.offsetWidth; flash.classList.add("burst");
      if (window.sfx) sfx.lock(tier);
      setTimeout(() => {
        overlay.classList.remove("spinning");
        reactorBusy = false;
        onLock();
      }, 260);
    }
    tick();
  }
```

- [ ] **Step 4: Route `randomize` through the reactor**

Replace `randomize` (~line 1280) with a version that fetches the pick, then animates, then commits the UI on lock. The server apply still happens in `/api/randomize` (unchanged); the reel is pure presentation that resolves to the already-picked name:

```js
  async function randomize() {
    if (reactorBusy) return;            // ignore re-entry; spin is short
    const res = await fetch("/api/randomize", { method: "POST" });
    const data = await res.json();
    const tier = (installedSchemes.find(s => s.name === data.scheme) || {}).rarity || "Common";
    runReactor(data.scheme, tier, () => {
      currentScheme = data.scheme;
      recordHistory(currentScheme);
      discover(currentScheme);
      renderPreview();
      renderGrid();
      showToast("Switched to " + data.scheme);
    });
  }
```

> Re-entry rule: per spec, pressing again mid-spin should skip to lock. The simplest robust behavior that avoids double server applies is to ignore the second press while spinning (the spin is ~1.2s). If you prefer true skip-to-lock, track the current reel's `lock` callback and invoke it early — optional polish, not required.

- [ ] **Step 5: Manual verification**

Run the app.
Expected:
- Clicking Randomize / pressing Space shows names blurring past in the preview, decelerating, then snapping to the final theme with a glow burst.
- The final theme matches what gets applied (preview + grid update after the burst).
- Rapid double-press does not double-apply or visually glitch.
- With OS "reduce motion" enabled (Windows: Settings → Accessibility → Visual effects → Animation effects OFF), randomize swaps instantly with no reel.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: reactor slot-reel randomize with lock-in burst"
```

---

## Task 8: Synthesized sound engine (client, manual verify)

**Files:**
- Modify: `server.js` (`sfx` audio module in `<script>`; sound toggle state + `toggleSound`; hover/confirm cues wired in; default-on with localStorage)

- [ ] **Step 1: Implement the `sfx` Web Audio module**

In the `<script>`, near the top of the functions (after the state block ~1064), add:

```js
  // --- Synthesized SFX (Web Audio, zero files) ---
  const sfx = (function () {
    let ctx = null, master = null, hum = null;
    let enabled = true;
    try { enabled = localStorage.getItem("terminalizer-sound") !== "off"; } catch (e) {}

    function ensure() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { enabled = false; return; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.18;
      master.connect(ctx.destination);
    }
    function blip(freq, dur, type, gain) {
      if (!enabled) return;
      ensure(); if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || "square"; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(gain || 0.3, ctx.currentTime + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (dur || 0.08));
      o.connect(g); g.connect(master);
      o.start(); o.stop(ctx.currentTime + (dur || 0.08) + 0.02);
    }
    function startHum() {
      if (!enabled || hum) return;
      ensure(); if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sawtooth"; o.frequency.value = 54;
      g.gain.value = 0.03; o.connect(g); g.connect(master); o.start();
      hum = { o, g };
    }
    function stopHum() { if (hum) { try { hum.o.stop(); } catch (e) {} hum = null; } }

    return {
      // call once on first user gesture
      arm() { if (!enabled) return; ensure(); if (ctx && ctx.state === "suspended") ctx.resume(); startHum(); },
      hover() { blip(880, 0.04, "sine", 0.06); },
      tick() { blip(320 + Math.random() * 80, 0.03, "square", 0.12); },
      lock(tier) {
        const big = tier === "Legendary" || tier === "Epic";
        blip(140, 0.18, "sawtooth", 0.35);
        if (big) setTimeout(() => blip(660, 0.25, "triangle", 0.25), 60);
      },
      confirm() { blip(520, 0.1, "triangle", 0.22); setTimeout(() => blip(780, 0.1, "triangle", 0.18), 70); },
      favorite() { blip(660, 0.08, "sine", 0.2); setTimeout(() => blip(990, 0.12, "sine", 0.18), 60); },
      achievement() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.16, "triangle", 0.22), i * 90)); },
      isEnabled() { return enabled; },
      setEnabled(v) {
        enabled = v;
        try { localStorage.setItem("terminalizer-sound", v ? "on" : "off"); } catch (e) {}
        if (v) this.arm(); else stopHum();
      },
    };
  })();
  window.sfx = sfx;
```

- [ ] **Step 2: Add `toggleSound` + reflect button state**

Near `applyProgress` (~line 1500), add:

```js
  function toggleSound() {
    sfx.setEnabled(!sfx.isEnabled());
    const btn = document.getElementById("sound-toggle");
    btn.classList.toggle("muted", !sfx.isEnabled());
    btn.textContent = sfx.isEnabled() ? "♪" : "♪̶";
    showToast(sfx.isEnabled() ? "Sound on" : "Sound off");
  }
```

- [ ] **Step 3: Arm audio on first gesture + set initial button state**

At the end of the `<script>` (just before `fetchState();` ~line 1554), add:

```js
  // Browser autoplay policy: audio can only start after a user gesture.
  function armAudioOnce() {
    sfx.arm();
    window.removeEventListener("pointerdown", armAudioOnce);
    window.removeEventListener("keydown", armAudioOnce);
  }
  window.addEventListener("pointerdown", armAudioOnce);
  window.addEventListener("keydown", armAudioOnce);
  (function () {
    const btn = document.getElementById("sound-toggle");
    if (btn) { btn.classList.toggle("muted", !sfx.isEnabled()); btn.textContent = sfx.isEnabled() ? "♪" : "♪̶"; }
  })();
```

- [ ] **Step 4: Wire confirm/favorite cues into existing actions**

- In `pickScheme` (~1290), after `currentScheme = data.scheme;` add `if (window.sfx) sfx.confirm();`.
- In `toggleFav` (~1342), after `favorites = data.favorites;` add `if (window.sfx && favorites.includes(name)) sfx.favorite();`.
- Add hover blips to control buttons: at the end of the `<script>` (after Step 3), add:

```js
  document.querySelectorAll(".btn, .tab, .filter-pill").forEach(el =>
    el.addEventListener("pointerenter", () => { if (window.sfx) sfx.hover(); }));
```

> `sfx.tick()` and `sfx.lock()` are already called from `runReactor` (Task 7), and `sfx.achievement()` from `achievementToast` (Task 6).

- [ ] **Step 5: Manual verification**

Run the app. Expected:
- After the first click anywhere, a faint low hum begins.
- Hovering buttons gives subtle blips; applying a theme gives a confirm tone; favoriting gives a chime.
- The reactor spin ticks during deceleration and "thunks" on lock (bigger for Epic/Legendary).
- The HUD ♪ toggles sound; state survives reload (toggle off, reload → stays off, button shows muted).

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: synthesized Web Audio SFX engine, on by default with HUD toggle"
```

---

## Task 9: HUD chrome + boot sequence + glitch text (client, manual verify)

**Files:**
- Modify: `server.js` (boot overlay markup before `.app` ~950; corner-bracket + boot + glitch CSS ~930; boot JS at script end; glitch-in on `tp-name` in `renderPreview`)

- [ ] **Step 1: Add boot overlay + corner brackets markup**

In `server.js`, immediately after `<body>` and the `aero-bg` block, before `<div class="app">` (~line 950), add:

```html
<div class="boot" id="boot" aria-hidden="true">
  <div class="boot-lines" id="boot-lines"></div>
</div>
```

Inside `<div class="app">`, as its first children (~line 951), add four bracket spans:

```html
  <span class="corner tl"></span><span class="corner tr"></span>
  <span class="corner bl"></span><span class="corner br"></span>
```

- [ ] **Step 2: Add boot + bracket + glitch CSS**

Before `</style>` (~line 930), add:

```css
    .app { position:relative; }
    .corner { position:fixed; width:26px; height:26px; border:2px solid var(--border-strong);
      pointer-events:none; opacity:0.55; z-index:3; }
    .corner.tl { top:14px; left:14px; border-right:0; border-bottom:0; }
    .corner.tr { top:14px; right:14px; border-left:0; border-bottom:0; }
    .corner.bl { bottom:14px; left:14px; border-right:0; border-top:0; }
    .corner.br { bottom:14px; right:14px; border-left:0; border-top:0; }
    .boot { position:fixed; inset:0; z-index:50; background:var(--bg);
      display:flex; align-items:center; justify-content:center; transition:opacity 0.4s; }
    .boot.done { opacity:0; pointer-events:none; }
    .boot-lines { font-family:'JetBrains Mono', monospace; font-size:0.85rem; color:var(--accent);
      text-shadow:0 0 8px var(--accent); min-width:320px; }
    .boot-lines .bl-line { opacity:0; white-space:pre; }
    .boot-lines .bl-line.in { opacity:1; }
    @keyframes glitch-in { 0%{opacity:0;transform:translateX(-2px);} 20%{opacity:1;transform:translateX(2px);}
      40%{transform:translateX(-1px);} 100%{transform:translateX(0);} }
    .glitch { animation:glitch-in 0.28s steps(2); }
    @media (prefers-reduced-motion: reduce) { .boot { display:none; } .glitch { animation:none; } }
```

- [ ] **Step 3: Boot sequence JS (once per session, skippable)**

At the start of the `<script>` execution path, just before `fetchState();` (~line 1554), add:

```js
  (function boot() {
    const el = document.getElementById("boot");
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let done = false;
    try { done = sessionStorage.getItem("terminalizer-booted") === "1"; } catch (e) {}
    if (reduce || done) { el.classList.add("done"); return; }
    const lines = ["> SYSTEM ONLINE", "> LOADING SCHEMES ...", "> PALETTE BANKS NOMINAL", "> REACTOR PRIMED"];
    const box = document.getElementById("boot-lines");
    box.innerHTML = lines.map(l => '<div class="bl-line">' + l + '</div>').join("");
    const nodes = box.querySelectorAll(".bl-line");
    function finish() {
      if (el.classList.contains("done")) return;
      el.classList.add("done");
      try { sessionStorage.setItem("terminalizer-booted", "1"); } catch (e) {}
    }
    nodes.forEach((n, i) => setTimeout(() => { n.classList.add("in"); if (window.sfx) sfx.tick(); }, 220 + i * 260));
    setTimeout(finish, 220 + nodes.length * 260 + 350);
    el.addEventListener("click", finish);
    window.addEventListener("keydown", finish, { once: true });
  })();
```

- [ ] **Step 4: Glitch-in theme names on change**

In `renderPreview` (~line 1160), where `tp-name` text is set, add a glitch class toggle:

```js
    const nameEl = document.getElementById("tp-name");
    nameEl.textContent = currentScheme;
    nameEl.style.color = s.foreground;
    nameEl.classList.remove("glitch"); void nameEl.offsetWidth; nameEl.classList.add("glitch");
```

(Replace the existing two `tp-name` lines with the above.)

- [ ] **Step 5: Manual verification**

Run the app in a fresh tab. Expected:
- A boot screen types four status lines, then fades to reveal the UI (~1.5s). Clicking or any key skips it.
- Reloading in the SAME tab does NOT replay boot (sessionStorage); a brand-new tab does.
- Faint corner brackets frame the viewport.
- Switching themes makes the preview name "glitch" in.
- Reduce-motion ON → no boot screen, no glitch.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: boot sequence, HUD corner brackets, glitch-in theme names"
```

---

## Task 10: Docs, version bump, final verification

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Update the README feature list**

In `README.md`, under `## Features`, add bullets:

```markdown
- **Reactor randomize** — the shuffle is a slot-reel that decelerates and locks in with a glow burst
- **Synthesized sound** — cyberpunk UI bleeps, ticks, and a reactor hum (Web Audio, zero files; toggle in the HUD)
- **Collection meta** — discovered counter, rarity tiers (Common→Legendary), achievements, and XP/level, saved to `~/.terminalizer/progress.json`
- **HUD + boot sequence** — a "SYSTEM ONLINE" boot, corner brackets, and glitch-in theme names
```

Add to the "How It Works" persistence note that `progress.json` is stored alongside favorites.

- [ ] **Step 2: Bump version**

In `package.json`, change `"version": "1.2.1"` to `"version": "1.3.0"`.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (smoke + rarity + progress + level + achievements).

- [ ] **Step 4: Full manual smoke of the running app**

Run: `$env:TERMINALIZER_NO_OPEN=1; node server.js`, open `http://localhost:3456`. Walk the spec verification checklist:
- Boot plays once, skippable, reduced-motion-aware.
- Reactor reel → tick decel → lock burst; rapid presses safe.
- Sound: hum arms on first gesture, toggle persists, all cues fire.
- Rarity badges stable across reloads.
- Discover counter increments on apply; `progress.json` written.
- Trigger an achievement (favorite 10) → toast + fanfare; persists across reload.
- Confirm a theme actually applies in Windows Terminal (open a WT tab).

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "docs: document Reactor game-feel; bump to v1.3.0"
```

---

## Self-review (completed)

- **Spec coverage:** Reactor spin → Task 7. Sound → Task 8. Collection meta (discovered/rarity/achievements/XP) → Tasks 2–6. HUD + boot + glitch → Task 9. Persistence (`progress.json`, atomic) → Task 4. Endpoints → Tasks 4/5. Reduced-motion handling → Tasks 3/7/9. Verification → Task 10. All spec sections map to tasks.
- **Deviations flagged:** rarity moved server-side; "ran auto-shuffle" achievement cut (both called out in "Refinements" up top).
- **Placeholder scan:** no TBD/TODO; every code step shows real code; every test step shows assertions and expected pass/fail.
- **Type/name consistency:** `RARITY_TIERS`, `rarityScore`, `rarityTier`, `defaultProgress`, `loadProgress`, `saveProgress`, `levelForXp`/client `levelFromXp`, `ACHIEVEMENTS`, `evaluateAchievements`, `sfx`, `runReactor`, `discover`, `applyProgress`, `achievementToast` are used consistently across tasks. (Server export is `levelForXp`; the client mirror is intentionally named `levelFromXp` to avoid implying it calls the server.)
- **Cross-task dependency note:** Task 4's discover route calls `evaluateAchievements` (Task 5) — flagged inline; implement Task 5's function before end-to-end testing the route.
