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
