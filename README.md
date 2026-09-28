# nejemax4-tauri

A small **Tauri 2** (Rust + React/TypeScript) desktop app for sending DXF
files and G-code to a **NEJE MAX4** laser engraver from macOS. Single-file
`.app` bundle, no Python / venv needed at runtime.

## Features

- Port auto-detection (filters to likely USB-CDC engraver ports).
- `$H` home, `$X` unlock, `G92` set-origin, soft-reset, feed-hold / resume.
- Arrow-key jog with adjustable step (0.1 – 50 mm) and feed rate.
- DXF preview with per-layer visibility, color, and live machine-position crosshair.
- Per-layer cut parameters: laser power, feed, passes, enable/disable.
- Streaming engine with `ok`-pong handshake, progress, and cancel (feed-hold + soft-reset).
- Dry-run mode (strips M3/M4 so the laser never fires).
- TX/RX log with raw-G-code send box.

### Beyond the NEJE (added 2026-05/06)

- **Silhouette CAMEO 5 cutter** — a separate libusb worker speaks GPGL to the CAMEO (USB printer-class device), with its own connection bar, layer table and job panel.
- **Tepra-style label generator** — typed text, GIF frames, or vector glyphs are laid out on a long narrow strip; outlines can be stroked in several inward passes and filled with zigzag, polygon or concentric infill (reimplemented from the published algorithm, no slicer code copied). Multilingual font stack with on-demand CJK loading.
- **unim → vector paths** — `userscripts/unim-copy-vector.user.js` adds "Copy Vectors" to [baku89's unim](https://baku89.github.io/unim/) so selected glyphs paste into the label generator as exact Bézier paths (no raster jaggies).
- **ESP32-S3 USB proxy uploader** — sends a job to an ESP32-S3 USB-OTG board over CDC-ACM and tells it to switch to host mode and stream to the engraver, so the job can run without the Mac attached (firmware lives in a separate project).

## Prerequisites (build machine — macOS)

```bash
# Xcode command-line tools (once):
xcode-select --install

# Rust toolchain (once):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable

# Node 18+ and npm:
brew install node
```

## Install dependencies

```bash
cd nejemax4-tauri
npm install
```

`npm install` pulls in the Tauri CLI, Vite, React, and `dxf-parser`. Nothing
is global; everything stays in `node_modules/`.

## Develop (hot-reload)

```bash
npx tauri dev
```

This runs Vite on `http://127.0.0.1:1420` and spawns the Tauri window. Edits
to the TS/React sources hot-reload; edits to the Rust sources trigger a
rebuild.

## Build a distributable `.app`

```bash
npx tauri build
```

Outputs end up in `src-tauri/target/release/bundle/`:

- `macos/NEJE MAX4 Controller.app` — drop-in `.app` (~10–15 MB release build).
- `dmg/NEJE MAX4 Controller_0.1.0_<arch>.dmg` — drag-to-install disk image.

### Universal binary (Apple Silicon + Intel)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
```

## Distribute to a few friends (no Apple Developer account needed)

The build above is **unsigned**. On the receiver's Mac, Gatekeeper will
refuse to run it straight away. Two workarounds:

### Option A — strip the quarantine attribute

After downloading, in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/NEJE MAX4 Controller.app"
```

Then double-click the app normally.

### Option B — right-click → Open

1. Drag the app into `/Applications`.
2. **Right-click** the app → **Open** → **Open** in the dialog.
3. From then on it launches like any other app.

### Ad-hoc self-signing (optional, prevents "damaged" errors on some Macs)

```bash
codesign --force --deep -s - "src-tauri/target/release/bundle/macos/NEJE MAX4 Controller.app"
```

## USB serial permissions

NEJE MAX4 shows up on macOS as `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*`
(CH340 / CH343 chip). No driver install needed on macOS 11+. If the port
doesn't appear:

```bash
ls /dev/cu.* | grep -iE 'usb|wch'
```

## Project layout

```
nejemax4-tauri/
├── index.html                 ← Vite entry
├── package.json / tsconfig    ← Frontend build
├── vite.config.ts
├── src/                       ← React + TS UI
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── lib/
│   │   ├── api.ts             ← Tauri IPC bindings
│   │   ├── dxf.ts             ← DXF parsing (dxf-parser wrapper)
│   │   └── gcode.ts           ← Polyline → GRBL G-code
│   └── components/
│       ├── ConnectionBar.tsx
│       ├── JogPanel.tsx
│       ├── DxfPanel.tsx
│       ├── DxfPreview.tsx     ← Canvas preview w/ layers + crosshair
│       ├── JobPanel.tsx       ← Start / cancel / dry-run
│       ├── LogView.tsx        ← TX/RX + send raw
│       └── PositionReadout.tsx
└── src-tauri/                 ← Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/default.json
    ├── icons/                 ← placeholder icons (replace with your own)
    └── src/
        ├── main.rs            ← Tauri commands + wiring
        ├── state.rs           ← Shared types, events, worker handle
        ├── grbl.rs            ← GRBL 1.1 protocol helpers + tests
        └── serial.rs          ← Port enum + streaming worker
```

## GRBL notes

- Baud defaults to **115200** — change in the UI if your firmware is different.
- The streamer uses the "simple" `ok`-pong model, not character counting. This
  keeps the worker simple and is plenty for a single operator over USB.
- Cancel = `!` (feed-hold) followed by `Ctrl-X` (soft-reset). The engraver
  immediately stops and re-homes to a known state.
- Jog-cancel = `0x85` real-time byte (GRBL 1.1 only).

## Dev: run Rust tests

```bash
cd src-tauri
cargo test
```

Currently covers `grbl::normalize_line`, ack/error/alarm detection, and the
status-report parser.

## Icons

`src-tauri/icons/*` are placeholder red circles with a white slit. Replace
before a real release; any 512×512 PNG will do — Tauri generates the other
sizes at build time.

## License

MIT — see [LICENSE](LICENSE).
