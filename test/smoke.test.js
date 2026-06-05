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
