const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
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

// --- Progress persistence (Task 4) ---
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

// --- XP / level + achievements (Task 5) ---
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
