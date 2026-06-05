# The Terminalizer → "Reactor": Game-Feel Design

**Date:** 2026-06-05
**Status:** Approved (pending spec review)
**Goal:** Make The Terminalizer feel like a cyberpunk *game* while keeping its existing Daft Punk / Terminator / cyberpunk aesthetic intact.

## Summary

The Terminalizer is a single-file Node app (`server.js`) that serves an embedded HTML/CSS/JS UI for randomizing and applying Windows Terminal color schemes. It already has a strong neon-glass "Daft Punk" visual identity (gold helmet / chrome helmet themes, Tron grid, scanlines, motes, red Cylon scanner).

This project layers **game feel** onto that foundation across four areas: a juicy randomize "reactor" spin, synthesized sound, a collection/progression meta, and HUD/boot-sequence chrome. No aesthetic pivot — the dark cyberpunk look stays; we make it *alive and rewarding to use*.

## Constraints

- **Single-file architecture preserved.** All UI stays embedded in `server.js`. No build step, no new runtime dependencies (Node stdlib + Web Audio + DOM only).
- **No new files shipped in the npm package** beyond what's already in `package.json` `files`. New *persisted user state* lives in `~/.terminalizer/` (the existing state dir, alongside `favorites.json` and `themes-cache.json`).
- **Accessibility:** honor the existing `prefers-reduced-motion` handling. All motion-heavy features degrade to instant/static.
- **Crash safety:** all writes to user state reuse the existing atomic write (temp file + rename).
- **Security:** no new external network surface; reuse existing CSRF/origin checks for new state-changing endpoints.

## Feature 1 — The Reactor Spin (core randomize)

The randomize action (button + `Space` shortcut + "Surprise me") becomes a slot-machine / loot-reveal reel.

**Sequence (~1.2s total):**
1. **Spin-up:** candidate theme names blur-scroll through the preview header; palette swatches strobe.
2. **Decelerate:** ease-out with a mechanical *tick* cadence; tick events drive Web Audio ticks.
3. **Lock-in:** final theme snaps into place → glow burst ring + brief screen-pulse/vignette flash; the 16 ANSI swatches cascade in.
4. **Rarity flourish:** scales with the landed theme's rarity tier (bigger burst for Epic/Legendary). First-time-discovered themes also get a "**NEW**" stamp.

**Rules:**
- `prefers-reduced-motion: reduce` → instant swap, no reel, no flash (matches existing pattern at `server.js:515`).
- Pressing randomize again mid-spin **skips to lock-in** immediately (no queue buildup).
- The actual server apply (`setSchemeServer` / `applyColorScheme`) fires at lock-in, not during the reel, so config writes aren't spammed.

## Feature 2 — Synthesized Sound (Web Audio, zero files)

A small in-browser audio engine using `AudioContext` oscillators + gain envelopes. No audio assets.

**Cues:**
- hover blip (subtle, debounced)
- reel tick (synced to deceleration cadence)
- lock-in *thunk* (low, punchy)
- apply confirm tone
- favorite chime
- achievement fanfare (short arpeggio)
- low reactor hum bed (looping, very quiet)

**Behavior:**
- **Default ON.** Toggle in the HUD status strip; state remembered in `localStorage`.
- Browser autoplay policy: `AudioContext` starts suspended and is `resume()`d on the first user gesture (boot-sequence dismiss / any click / keypress). The hum bed begins at that point, not literally at page load.
- A master gain keeps everything subtle; reduced-motion does **not** disable sound (separate concern), but the toggle does.

## Feature 3 — Collection Meta (`~/.terminalizer/progress.json`)

Turns browsing into collecting. New persisted file, atomic writes.

**Discovered counter:** `247 / 515`. A theme becomes "discovered" the first time it is previewed or applied. Shown in the HUD strip.

**Rarity tiers (deterministic, computed client-side from palette data already sent):**
- Tiers: Common / Uncommon / Rare / Epic / Legendary.
- Derivation: a score from the scheme's 16-color palette combining **saturation spread**, **average brightness balance**, and **hue diversity** (count of distinct hue buckets). Thresholds map score → tier. Deterministic: same palette always yields the same tier.
- Display: a colored gem/badge on each theme card and in the preview panel.

**Achievements (milestone set):**
- Discovered 10 / 100 / all 515
- Favorited 10
- Applied a Legendary theme
- Ran auto-shuffle for the first time
- Applied a near-black / very-low-brightness ("Brutal") palette
- (Final list finalized during planning; structure is an array of `{id, label, unlockedAt}`.)
- Unlock → toast notification + achievement fanfare sound.

**XP / level (light, cosmetic):**
- Small XP awarded on first-discovery and on favorite.
- Level = simple function of XP. Shown as a readout in the HUD. Purely cosmetic — no gating of features.

**Persistence shape (`progress.json`):**
```json
{
  "discovered": ["Theme Name", "..."],
  "achievements": [{ "id": "discover_100", "unlockedAt": 1733... }],
  "xp": 1240
}
```
(Exact shape finalized in the plan; `discovered` + `achievements` + `xp` are the essentials.)

## Feature 4 — HUD Chrome + Boot Sequence

**Boot sequence (~1.5s, once per session):**
- Scanline wipe + status lines typing in ("SYSTEM ONLINE", "LOADING SCHEMES…", "REACTOR PRIMED"), then UI fades up.
- Skippable (click / any key). Tracked per session (so re-renders within a session don't replay it).
- Reduced-motion → skip straight to UI.

**HUD frame:**
- Animated corner brackets around the app shell.
- Top **status strip**: discovered count • level • current theme's rarity • sound toggle.
- Glitch / scramble-in text effect on theme names when they change (reduced-motion → plain text).

## Server changes

New endpoints (reusing existing origin/CSRF guard at `server.js` `originAllowed`):
- `GET /api/progress` → returns `progress.json` contents (or defaults).
- `POST /api/progress/discover` → body `{ name }`; marks discovered, recomputes XP/level, evaluates achievement unlocks server-side, returns `{ progress, newlyUnlocked: [...] }`.
- Achievement evaluation that depends on favorites count reads existing favorites.

Rarity is **not** a server concern — computed client-side from palette colors the client already has.

Helpers to add (mirroring existing `loadFavorites`/`saveFavorites`/`atomicWrite`): `loadProgress`, `saveProgress`.

## Data flow

1. Page load → `GET /api/progress` (alongside existing `fetchState`).
2. Boot sequence plays → UI renders → audio arms on first gesture.
3. Randomize → reactor spin → lock-in → `setSchemeServer` + `POST /api/progress/discover`.
4. New achievements in the response → toast + fanfare.
5. Rarity badges rendered from palette math during `renderGrid` / `renderPreview`.

## Error handling

- `progress.json` missing/corrupt → start from defaults, log once, continue (matches `loadFavorites` tolerance).
- Web Audio unavailable / blocked → silently no-op; UI fully functional without sound.
- `/api/progress/discover` failure → UI still applies the theme; progress sync is best-effort and retried on next discover.

## Verification

Manual launch checklist:
- Boot sequence plays once, skippable, respects reduced-motion.
- Randomize shows reel → tick deceleration → lock-in burst; rapid presses skip cleanly.
- Sound: hum arms on first gesture, toggle persists across reload, all cues fire.
- Rarity badges appear and are stable across reloads for the same theme.
- Discover counter increments on first preview; `progress.json` written atomically.
- Trigger an achievement → toast + fanfare; persists across reload.
- `prefers-reduced-motion: reduce` → instant swaps, no boot reel, no glitch text.

## Build order (single branch, one bundled PR)

1. Reactor spin (visual reel + lock-in, no sound yet)
2. Sound engine (wire cues into reel + interactions)
3. HUD chrome + boot sequence
4. Collection meta (server endpoints + rarity + achievements + XP)

Each layer is independently testable but ships together as one PR (matches the user's preference for bundled refactor PRs).

## Out of scope (YAGNI)

- Online leaderboards / multiplayer (dialed.gg has them; this is a local single-user tool).
- A "daily theme" feature (possible future add; not in this pass).
- CRT post-processing shader / full-screen glitch filter (can revisit if the lighter glitch text isn't enough).
