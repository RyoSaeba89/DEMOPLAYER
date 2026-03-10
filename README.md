# DEMOPLAYER v4.0 — Cracktro Edition

A browser-based chiptune and demoscene music player with a keygen/cracktro aesthetic. Supports MOD, XM, IT, S3M, V2M, and MIDI formats through a multi-engine architecture sharing a single Web Audio context. Audio files are streamed on demand from Cloudflare R2, keeping the app lightweight while supporting playlists of any size. Features include a real-time spectrum analyzer, sine-wave scrolltext, starfield background, playlist management with drag & drop, and full keyboard controls — all wrapped in a dark terminal UI with neon accents.

---

## Supported Formats

| Format | Engine | Description |
|--------|--------|-------------|
| MOD, XM, IT, S3M | libopenmpt (WASM) | ProTracker, FastTracker II, Impulse Tracker, Scream Tracker |
| V2M | farbrausch V2 (WASM AudioWorklet) | farbrausch V2 Synthesizer System |
| MID / MIDI | MidiPlayerJS + GM Synth | Standard MIDI Files with General MIDI playback |

Also supports: MPTM, MED, OCT, OKT, STM, 669, FAR, AMF, AMS, DBM, DMF, DSM, UMX, MT2, PSM, J2B, GDM, IMF, PTM, SFX, MO3, MTM.

---

## Architecture

```
GitHub Pages                        Cloudflare R2
┌────────────────────┐              ┌──────────────────────┐
│  index.html        │              │  Ryo/                │
│  style.css         │   fetch()    │    Vol 1 - .../      │
│  player.js         │ ───────────► │    Vol 2 - .../      │
│  lib/              │              │  KEYGENMUSiC/        │
│  playlists/*.json  │              │    ...               │
└────────────────────┘              └──────────────────────┘
       ~5 MB                              ~750 MB
```

Playlist JSON files are served from GitHub Pages. Audio files are fetched on demand from Cloudflare R2 (lazy loading), so no audio data is stored in the repository.

---

## Project Structure

### Core Files

| File | Description |
|------|-------------|
| `index.html` | Main entry point. Contains the full UI markup, canvas elements (starfield, sine scroller, visualizer), inline security scripts, SVG icon definitions, and Content Security Policy headers. |
| `player.js` | Application logic (ES module). Multi-engine orchestration, playlist management, lazy audio loading, JSON playlist parser with R2 path resolution, spectrum visualizer, drag & drop handler, keyboard shortcuts, and all transport controls. |
| `style.css` | Complete UI styling. Dark terminal theme with CSS custom properties for the neon palette, responsive layout (desktop → mobile → landscape), playlist grid, transport buttons, progress bar, and animated playlist buttons. |
| `coi-serviceworker.js` | Service worker that injects `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` headers, enabling `SharedArrayBuffer` required by the V2M WASM AudioWorklet engine. |

### Audio Engine Libraries (`lib/`)

| File | Description |
|------|-------------|
| `chiptune3.js` | Wrapper around libopenmpt — handles MOD/XM/IT/S3M and 20+ tracker formats via WASM. |
| `libopenmpt.js` + `libopenmpt.wasm` | Compiled libopenmpt library (C++ → WebAssembly). |
| `v2m-worklet.js` | farbrausch V2M engine running in an AudioWorklet for real-time synthesis. |
| `midi-engine.js` | MIDI playback engine using MidiPlayerJS with a custom General MIDI synthesizer. |

### Playlist Data (`playlists/`)

| File | Description |
|------|-------------|
| `Ryo/Ryo.json` | Curated playlist — 276 tracks (keygen music + chiptunes), ~7h30 total. |
| `KEYGENMUSiC/KEYGENMUSiC.json` | Full KEYGENMUSiC archive — 5,078 tracks, ~190h total. |

Each JSON file contains metadata (filename, title, path, extension, duration) but no audio data.

---

## Features

- **Multi-engine playback** — Three audio engines (libopenmpt, V2M, MIDI) sharing a single `AudioContext`, with automatic engine selection based on file extension.
- **Lazy audio loading** — Audio files are fetched from Cloudflare R2 only when playback starts, keeping RAM usage minimal regardless of playlist size.
- **Real-time spectrum analyzer** — 48-band FFT visualizer with neon gradient bars, peak indicators with gravity decay, and a grid overlay.
- **Sine-wave scrolltext** — Classic demoscene-style scrolling text rendered on canvas with per-character sine displacement and color cycling.
- **Animated starfield** — Full-screen background canvas with 120 drifting, twinkling stars.
- **Playlist management** — Add files, scan directories, load JSON playlists, remove individual tracks, clear all. Supports drag & drop of files and folders.
- **Transport controls** — Play/pause, stop, previous/next, seek (click on progress bar), loop, shuffle (no-repeat), and volume slider.
- **Keyboard shortcuts** — Space (play/pause), Left/Right arrows (prev/next).
- **MIDI channel detection** — Parses MIDI tracks on-the-fly to display active channel count.
- **Duration pre-scan** — Background scanner reads track duration without producing audio output.
- **Per-format badges** — Color-coded extension badges in both the header and playlist, with distinct colors for each format family.
- **Responsive design** — Adapts from desktop (820px max) down to 360px screens and landscape mobile.
- **Security hardening** — Content Security Policy, anti-framing, context menu / DevTools / selection blocking, HTML escaping verification.

---

## Deployment

### Prerequisites

- A [Cloudflare](https://dash.cloudflare.com) account (free tier)
- A GitHub account with Pages enabled

### Setup

1. **Cloudflare R2** — Create a bucket, enable public access (R2.dev subdomain), configure CORS for your GitHub Pages domain, and upload audio files with [rclone](https://rclone.org/).

2. **player.js** — Set the `R2_BASE` constant to your R2 public URL:
   ```javascript
   const R2_BASE = 'https://pub-xxxxxxxxxxxx.r2.dev/';
   ```

3. **index.html** — Ensure the CSP `connect-src` directive includes your R2 domain:
   ```
   connect-src 'self' blob: data: https://pub-xxxxxxxxxxxx.r2.dev;
   ```

4. **GitHub Pages** — Push the repository and enable Pages from the `main` branch root.

### Local Development

```bash
npx serve .
# or
python3 -m http.server 8080
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `→` | Next track |
| `←` | Previous track |

---

## Credits

- [libopenmpt](https://lib.openmpt.org/) — OpenMPT team
- [farbrausch V2](https://github.com/farbrausch/fr_public) — farbrausch
- [MidiPlayerJS](https://github.com/grimmdude/MidiPlayerJS) — grimmdude
- [IBM Plex Mono](https://github.com/IBM/plex) — IBM
- [VT323](https://fonts.google.com/specimen/VT323) — Peter Hull

---

## License

MIT
