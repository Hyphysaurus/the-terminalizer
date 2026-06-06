# The Terminalizer

Randomize, preview, and hot-swap your Windows Terminal themes from a sleek web UI.

![The Terminalizer](https://img.shields.io/npm/v/the-terminalizer?style=flat-square&color=bb9af7) ![License](https://img.shields.io/npm/l/the-terminalizer?style=flat-square)

## Features

- **515+ themes** — browse, install, and apply in one click from the iTerm2 Color Schemes collection
- **Live preview** — see each theme rendered, including its full 16-color ANSI palette, before applying
- **Randomize** — one click to switch to a random theme
- **Random favorite** — jump to a random theme from your favorites
- **Surprise me** — install & apply a random theme from all 515+
- **Auto-shuffle** — cycle through themes on a timer (30s to 30m), all themes or favorites only
- **Undo / redo** — multi-step history, so you can step back and forth between themes
- **Favorites** — star the themes you love, shuffle from favorites only
- **Font size & opacity** — adjust terminal font size and window transparency (acrylic) from the UI
- **Cursor & selection colors** — override them per your taste, or reset to the scheme's own
- **Apply to all profiles** — change every profile at once, not just the default
- **Export** — copy the current scheme's JSON to your clipboard
- **Search, sort & filter** — filter by name, sort by A–Z / brightness / hue, filter dark vs light
- **Themeable UI** — gold ⇄ chrome "helmet" toggle (remembered across sessions)
- **Live action terminal** — the preview is a real, typeable command line. Type `random`, `apply <name>` (Tab-completes), `fav`, `surprise`, `undo`/`redo`, `dark`/`light`, `sound`, `rarity`, `find <q>`, `clear`, `help`; every action decodes in as themed log lines that show the actual `colorScheme` change written to your config
- **Casino slot header** — Randomize spins the "TERMINALIZER" title like a slot machine, decelerating and locking on the result; transient messages slot into it too
- **Jackpot** — landing an Epic or Legendary theme triggers a payoff: title burst, glyph confetti, coin chord, and a shake
- **True rarity** — tiers reflect how *unusual* a palette is versus the whole collection (not availability): each theme gets an HSL color signature and is ranked by distance to its nearest look-alikes. Legendary = top 3% most unusual. An in-app **ⓘ** explains exactly how it's computed
- **Rarity filter & Rare+ shuffle** — filter the list by tier, and restrict auto-shuffle to Rare/Epic/Legendary
- **Synthesized sound** — cyberpunk UI bleeps, ticks, a reactor hum, and a rarity-pitched lock chord (Web Audio, zero files; toggle in the HUD)
- **Collection meta** — discovered counter, achievements, and XP/level, saved to `~/.terminalizer/progress.json`
- **HUD + boot sequence** — a "SYSTEM ONLINE" boot, corner brackets, a live status strip, and glitch-in theme names
- **Grid ⇄ list views** — denser cards with windowed rendering for 500+ themes, plus a compact list view

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `Space` | Randomize |
| `U` | Undo |
| `R` | Redo |
| `F` | Favorite the current theme |
| `/` | Focus search |

## Install

```bash
npx the-terminalizer
```

Or install globally:

```bash
npm install -g the-terminalizer
the-terminalizer
```

It opens **http://localhost:3456** in your browser automatically (set `TERMINALIZER_NO_OPEN=1` to disable).

## Requirements

- **Windows Terminal** (installed from Microsoft Store)
- **Node.js** 14+
- Works on **Windows** and **WSL**

## Configuration

By default, The Terminalizer auto-detects your Windows Terminal `settings.json`. If detection fails, set the path manually:

```bash
TERMINAL_SETTINGS_PATH="/path/to/settings.json" the-terminalizer
```

Change the port:

```bash
PORT=8080 the-terminalizer
```

Don't auto-open the browser:

```bash
TERMINALIZER_NO_OPEN=1 the-terminalizer
```

## How It Works

The Terminalizer reads and writes your Windows Terminal `settings.json` to swap color schemes in real time. Your favorites and theme cache are stored in `~/.terminalizer/`, as is `progress.json` (your discovered themes, achievements, and XP). Before its first write, it saves a one-time backup of your original `settings.json` to `~/.terminalizer/settings.backup.json`, and all writes are atomic (temp file + rename) so a crash can't corrupt your config. Edits are surgical — your comments and formatting in `settings.json` are preserved (except when "apply to all profiles" is on, which rewrites the file).

Auto-detects stable, Preview, and unpackaged Windows Terminal installs.

## Security

The Terminalizer modifies your terminal configuration, so it is designed to stay on your machine:

- The server binds to **`127.0.0.1` only** — it is not reachable from your local network.
- State-changing requests are protected against **CSRF** (cross-site requests are rejected).
- Theme installs are restricted to the official iTerm2-Color-Schemes source on GitHub.

## License

MIT
