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

Then open **http://localhost:3456** in your browser.

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

## How It Works

The Terminalizer reads and writes your Windows Terminal `settings.json` to swap color schemes in real time. Your favorites and theme cache are stored in `~/.terminalizer/`. Before its first write, it saves a one-time backup of your original `settings.json` to `~/.terminalizer/settings.backup.json`, and all writes are atomic (temp file + rename) so a crash can't corrupt your config. Edits are surgical — your comments and formatting in `settings.json` are preserved (except when "apply to all profiles" is on, which rewrites the file).

Auto-detects stable, Preview, and unpackaged Windows Terminal installs.

## Security

The Terminalizer modifies your terminal configuration, so it is designed to stay on your machine:

- The server binds to **`127.0.0.1` only** — it is not reachable from your local network.
- State-changing requests are protected against **CSRF** (cross-site requests are rejected).
- Theme installs are restricted to the official iTerm2-Color-Schemes source on GitHub.

## License

MIT
