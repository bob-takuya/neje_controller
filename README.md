# neje_controller (NEJE MAX4 Controller)

A **Tauri 2** (Rust + React/TypeScript) desktop app for sending DXF files and G-code to a **NEJE MAX4** laser engraver (GRBL), which also grew a **Silhouette CAMEO 5** cutter mode, a Tepra-style label generator and an ESP32-S3 proxy uploader.

NEJE MAX4 レーザー彫刻機（＋ Silhouette CAMEO 5）を Mac から動かすための自作コントローラ。

## Status

**Usable for the NEJE MAX4 on the author's setup; everything added later is experimental.** The GRBL/NEJE path has been iterated against the real machine (stall fixes, streaming protocol changes, resume). The CAMEO, label, ESP32 and unim features were added in one batch and have no automated tests. Unsigned builds, placeholder icons, version 0.1.0.

✅ **Works (used on the NEJE MAX4)**
- Serial port auto-detection (CH340/CH343 USB-serial), connect at 115200 baud by default
- `$H` home, `$X` unlock, `G92` set origin, soft reset, feed hold / cycle start, arrow-key jog with jog-cancel
- DXF import with per-layer visibility, color, power, feed, passes, enable/disable, and layer cut-order reordering
- G-code streaming with GRBL **character counting** (120-byte window), progress, cancel (feed hold + soft reset)
- Dense polylines fitted to arcs + lines (biarc) so the GRBL planner doesn't stall; can be disabled per job
- M4 kept on for the whole job to avoid per-shape sync stalls
- Resume a stopped job from a given line
- Dry run (M3/M4 lines replaced so the laser never fires); laser test-pattern generator; TX/RX log with raw send box
- Rust unit tests for GRBL line normalisation, ack/error/alarm detection, status parsing and the ESP proxy helpers (`cargo test`)

🚧 **Partial or rough**
- **Silhouette CAMEO 5** mode (`cameo.rs`, libusb via `rusb`, GPGL): connect, status, jog, home, cut per layer with tool 1/2, speed, force, AutoBlade depth, mat presets. Targets PID `0x1140`; other Graphtec/Silhouette models are only recognised by name, untested
- **Tepra-style label generator** (CAMEO only): text / GIF frames / vector glyphs on a long strip, inward stroke passes and zigzag / polygon / concentric infill, multilingual font stack with on-demand CJK loading
- **unim → vector paths**: `userscripts/unim-copy-vector.user.js` adds "Copy Vectors" to [unim](https://baku89.github.io/unim/) so glyphs paste into the label generator as Bézier paths
- **ESP32-S3 USB proxy uploader** (`esp_proxy.rs`): uploads a job with CRC over CDC-ACM and asks the board to switch to host mode and stream to the engraver. Needs custom firmware that is **not included** in this repo
- CI release workflow builds macOS / Linux / Windows installers, but only macOS is used day-to-day; Linux/Windows builds are untested on hardware

📝 **Not implemented yet**
- DXF entities with a non-axis-aligned extrusion direction (full Arbitrary Axis Algorithm) — treated as identity
- Real app icons (current ones are placeholder red circles)
- Code signing / notarisation
- Frontend tests (the `bench-*.mjs` scripts are ad-hoc benchmarks, not a test suite)

⚠️ **Known issues & limitations**
- Default work area and placement assume the NEJE MAX4 (400 × 400 mm)
- Unsigned build: Gatekeeper blocks it on first launch (see below)
- Some `bench-*.mjs` scripts point at local DXF files and won't run as-is

## Background

Started 2026-05 as a single-file `.app` replacement for sending DXF/G-code to the NEJE MAX4 from macOS; the CAMEO / label / ESP32 work followed in 2026-05–06 and was published in 2026-09.

## Prerequisites (build machine — macOS)

```bash
xcode-select --install                                        # once
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # Rust toolchain
rustup default stable
brew install node                                             # Node 18+
```

## Install dependencies

```bash
cd neje_controller
npm install
```

`npm install` pulls in the Tauri CLI, Vite, React, `dxf-parser`, `clipper-lib` and `opentype.js`. Everything stays in `node_modules/`. The CAMEO backend static-links libusb (`rusb` `vendored`), so no system libusb is needed.

## Develop (hot-reload)

```bash
npx tauri dev
```

Runs Vite on `http://127.0.0.1:1420` and spawns the Tauri window.

## Build a distributable `.app`

```bash
npx tauri build
```

Outputs end up in `src-tauri/target/release/bundle/` (`macos/NEJE MAX4 Controller.app` and a `.dmg`).

Universal binary:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin
```

### Running the unsigned build on another Mac

```bash
xattr -dr com.apple.quarantine "/Applications/NEJE MAX4 Controller.app"
# or: right-click the app → Open → Open
# optional ad-hoc signature:
codesign --force --deep -s - "src-tauri/target/release/bundle/macos/NEJE MAX4 Controller.app"
```

## USB permissions

- **NEJE MAX4** appears as `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*` (CH340 / CH343). No driver needed on macOS 11+. Check with `ls /dev/cu.* | grep -iE 'usb|wch'`.
- **CAMEO 5** is a USB printer-class device (VID `0x0b4d`); it has no `/dev/cu.*` node and is opened directly over libusb. Quit Silhouette Studio first if it holds the device.

## Project layout

```
neje_controller/
├── index.html, package.json, vite.config.ts, tsconfig*.json
├── bench-*.mjs                ← ad-hoc G-code / biarc / resume benchmarks
├── userscripts/               ← unim "Copy Vectors" userscript
├── src/                       ← React + TS UI
│   ├── App.tsx
│   ├── lib/
│   │   ├── api.ts             ← Tauri IPC bindings
│   │   ├── dxf.ts             ← DXF parsing + biarc fit
│   │   ├── gcode.ts           ← polyline → GRBL G-code (+ resume)
│   │   ├── testPattern.ts
│   │   ├── cameoGpgl.ts       ← DXF → GPGL for the CAMEO
│   │   ├── tepra*.ts, polygonFill.ts, concentricFill.ts, textVector.ts, fontStack.ts
│   │   └── unimVector.ts
│   └── components/            ← ConnectionBar, JogPanel, DxfPanel, DxfPreview, JobPanel,
│                                 LogView, PositionReadout, TestPatternPanel,
│                                 Cameo*.tsx, TepraPanel
└── src-tauri/
    ├── tauri.conf.json, capabilities/, icons/ (placeholders)
    └── src/
        ├── main.rs            ← Tauri commands + wiring
        ├── state.rs           ← shared types, events
        ├── grbl.rs            ← GRBL 1.1 helpers + tests
        ├── serial.rs          ← port enumeration + character-counting streamer
        ├── cameo.rs           ← CAMEO GPGL worker (libusb)
        └── esp_proxy.rs       ← ESP32-S3 proxy uploader + tests
```

## GRBL notes

- Baud defaults to **115200**.
- Streaming uses GRBL character counting (per the GRBL streaming wiki): up to 120 bytes of un-acked lines in flight, which keeps the planner fed on small geometry where one-line-per-`ok` round trips cause visible pauses.
- Cancel = `!` (feed hold) then `Ctrl-X` (soft reset). Jog-cancel = `0x85` (GRBL 1.1).

## Dev: run Rust tests

```bash
cd src-tauri
cargo test
```

## Related

- [cameo-cut](https://github.com/bob-takuya/cameo-cut) — earlier Python/PyQt6 CAMEO 5 controller (USB + BLE); the CAMEO mode here is the newer Rust/Tauri take
- [uls-mac-driver](https://github.com/bob-takuya/uls-mac-driver) — experimental macOS driver for ULS laser cutters (same series of Mac fabrication tools)

## License

MIT — see [LICENSE](LICENSE).
