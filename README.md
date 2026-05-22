# The Terminalizer

Randomize, preview, and hot-swap your Windows Terminal themes from a sleek web UI.

![The Terminalizer](https://img.shields.io/npm/v/the-terminalizer?style=flat-square&color=bb9af7) ![License](https://img.shields.io/npm/l/the-terminalizer?style=flat-square)

## Features

- **515+ themes** — browse and install from the iTerm2 Color Schemes collection
- **Live preview** — see how each theme looks before applying it
- **Randomize** — one click to switch to a random theme
- **Auto-shuffle** — cycle through themes on a timer (30s to 30m)
- **Favorites** — star the themes you love, shuffle from favorites only
- **Font size control** — adjust terminal font size from the UI
- **Opacity slider** — set window transparency with acrylic blur
- **Search** — filter through all installed and available themes

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

The Terminalizer reads and writes your Windows Terminal `settings.json` to swap color schemes in real time. Your favorites and theme cache are stored in `~/.terminalizer/`.

## License

MIT
