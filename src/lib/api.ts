// Tauri IPC bindings. One thin layer over `invoke` / `listen` so React components
// don't touch the Tauri API surface directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type PortInfo = {
  name: string;
  kind: "usb" | "bluetooth" | "pci" | "unknown";
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
};

export type LogLine = {
  level: "info" | "warn" | "error" | "tx" | "rx";
  text: string;
};

export type Status = {
  state: string;
  mpos: [number, number, number] | null;
  wpos: [number, number, number] | null;
  feed: number | null;
  spindle: number | null;
  buffer: [number, number] | null;
  raw: string;
};

export type ConnState = {
  connected: boolean;
  port: string | null;
  baud: number | null;
};

export type Progress = {
  sent: number;
  total: number;
  line: string;
};

export type Finished = {
  cancelled: boolean;
  error: string | null;
};

// ---- Port classification --------
//
// We auto-connect by recognizing the USB peripheral the user just plugged in.
// Only two kinds matter:
//   - "esp"    : the ESP32-S3 proxy running our DEVICE-mode firmware. Tauri
//                talks to it over CDC for upload + ARM/RUN. Jog/Stream
//                doesn't apply because the ESP isn't currently talking to
//                the engraver — it's only relaying jobs.
//   - "direct" : the NEJE engraver plugged straight into the PC. Full GRBL
//                surface available (jog, stream, manual commands).
//   - "unknown": any other USB-serial port we don't recognize.

export type PortKind = "esp" | "direct" | "unknown";

const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

export function classifyPort(p: PortInfo): PortKind {
  // ESP TinyUSB CDC: product string typically "Espressif Device" (our
  // device-mode firmware uses the TinyUSB defaults: VID 0x303A, PID 0x4003
  // for the composite CDC+MSC). The CDC ACM port enumerates with that
  // product string.
  if (lc(p.manufacturer).includes("espressif")) return "esp";
  if (lc(p.product).includes("espressif")) return "esp";
  // NEJE MAX4: verified VID 0x3C2E manufacturer "Zhixinjie", product
  // "NEJE Device" (see ESP32-S3ref.md). Catch by either field.
  if (lc(p.product).includes("neje")) return "direct";
  if (lc(p.manufacturer).includes("zhixinjie")) return "direct";
  if (lc(p.serial_number).includes("neje")) return "direct";
  return "unknown";
}

// ---------- Commands ----------

export const listPorts = (onlyLikely = true): Promise<PortInfo[]> =>
  invoke("cmd_list_ports", { onlyLikely });

/** An installed font file, for the tepra font dropdown. */
export type FontEntry = { path: string; label: string };

/** Enumerate installed fonts (.ttf/.otf/.ttc) from the OS font folders. */
export const listFonts = (): Promise<FontEntry[]> => invoke("cmd_list_fonts");

/** One decoded GIF frame: a packed 1-bit black mask (base64), width×height. */
export type GifFrameMask = { width: number; height: number; bits_b64: string };

/**
 * Decode a GIF file (by path) into per-frame black masks, in Rust — the
 * webview's WebCodecs ImageDecoder isn't available in the Tauri runtime. A
 * pixel is "black/ON" where luma < `threshold` and it isn't transparent.
 * Frames are downscaled so the longest side ≤ `maxSide`.
 */
export const decodeGif = (
  path: string,
  threshold = 128,
  maxSide = 256,
): Promise<GifFrameMask[]> =>
  invoke("cmd_decode_gif", { path, threshold, maxSide });

export const connect = (port: string, baud = 115200): Promise<void> =>
  invoke("cmd_connect", { args: { port, baud } });

export const disconnect = (): Promise<void> => invoke("cmd_disconnect");

export const sendLine = (line: string): Promise<void> =>
  invoke("cmd_send_line", { line });

export const jog = (dx: number, dy: number, feed: number, dz = 0): Promise<void> =>
  invoke("cmd_jog", { args: { dx, dy, dz, feed } });

export const jogCancel = (): Promise<void> => invoke("cmd_jog_cancel");
export const home = (): Promise<void> => invoke("cmd_home");
export const unlock = (): Promise<void> => invoke("cmd_unlock");
export const setOrigin = (): Promise<void> => invoke("cmd_set_origin");
export const pollStatus = (): Promise<void> => invoke("cmd_status_poll");
export const feedHold = (): Promise<void> => invoke("cmd_feed_hold");
export const cycleStart = (): Promise<void> => invoke("cmd_cycle_start");
export const softReset = (): Promise<void> => invoke("cmd_soft_reset");

export const stream = (lines: string[]): Promise<void> =>
  invoke("cmd_stream", { lines });

export const cancelStream = (): Promise<void> => invoke("cmd_cancel_stream");

export const connectionInfo = (): Promise<[string, number] | null> =>
  invoke("cmd_connection_info");

/**
 * Upload a G-code program to the ESP32-S3 NEJE proxy board via its CDC port.
 * Returns [bytes_uploaded, crc32].
 *
 * The ESP must be running the neje_proxy device-mode firmware (boot without
 * BTN_OK held). `port` is its CDC port (e.g. /dev/cu.usbmodem...).
 */
export const espUpload = (
  port: string,
  name: string,
  lines: string[],
  runAfterUpload: boolean,
): Promise<[number, number]> =>
  invoke("cmd_esp_upload", { args: { port, name, lines, run_after_upload: runAfterUpload } });

/**
 * Send a one-shot CDC command (WIPE, DISARM, etc) to the ESP and return its
 * single-line reply. The port is opened and closed for this single round-trip,
 * so the caller is expected to be holding the serial port (i.e. have called
 * `disconnect()` first).
 */
export const espCommand = (port: string, cmd: string): Promise<string> =>
  invoke("cmd_esp_command", { args: { port, cmd } });

export const espWipe = (port: string): Promise<string> => espCommand(port, "WIPE");
export const espDisarm = (port: string): Promise<string> => espCommand(port, "DISARM");
export const espArm = (port: string): Promise<string> => espCommand(port, "ARM");

/** A job stored on the ESP's FAT drive (from the `LIST` command). */
export type EspJob = { name: string; bytes: number };

/**
 * List the jobs currently saved in the ESP's memory (FAT drive). Use after an
 * upload to confirm the job actually landed on the board.
 */
export const espListJobs = (port: string): Promise<EspJob[]> =>
  invoke("cmd_esp_list_jobs", { args: { port } });

// ---------- CAMEO 5 (Silhouette cutter over USB bulk) ----------
//
// The CAMEO is a separate machine backend (raw USB, GPGL — not GRBL serial).
// It reuses the same log/status/progress/finished event streams, so the
// listeners above cover it; only the command surface differs.

export type CameoInfo = {
  vid: number;
  pid: number;
  model: string;
  serial: string | null;
  bus: number;
  address: number;
};

/** Machine setup applied before a cut (matches Rust `CameoSetup`). */
export type CameoSetup = {
  tool: number;
  speed: number;
  force: number;
  depth: number;
  auto_blade: boolean;
  blade_offset_mm: number;
  accel: number;
  mat: number;
  track_enhancing: boolean;
  area_w_mm: number;
  area_h_mm: number;
};

/** List connected Silhouette/Graphtec USB devices. */
export const cameoList = (): Promise<CameoInfo[]> => invoke("cmd_cameo_list");

/** Connect to a CAMEO by PID (bus/address 0 = first match). */
export const cameoConnect = (
  pid: number,
  bus = 0,
  address = 0,
): Promise<void> => invoke("cmd_cameo_connect", { args: { pid, bus, address } });

export const cameoDisconnect = (): Promise<void> => invoke("cmd_cameo_disconnect");
export const cameoStatus = (): Promise<void> => invoke("cmd_cameo_status");

/** Send raw GPGL command lines (manual console / smoke test). */
export const cameoSend = (lines: string[]): Promise<void> =>
  invoke("cmd_cameo_send", { lines });

/** Apply setup then stream a GPGL program (the "Cut" action). */
export const cameoRun = (setup: CameoSetup, lines: string[]): Promise<void> =>
  invoke("cmd_cameo_run", { args: { setup, lines } });

export const cameoCancel = (): Promise<void> => invoke("cmd_cameo_cancel");

/** Pen-up relative move in mm (positioning jog). */
export const cameoJog = (dx: number, dy: number): Promise<void> =>
  invoke("cmd_cameo_jog", { args: { dx, dy } });

export const cameoHome = (): Promise<void> => invoke("cmd_cameo_home");

/** Currently-connected CAMEO model + serial, or null. */
export const cameoInfo = (): Promise<[string, string | null] | null> =>
  invoke("cmd_cameo_info");

// ---------- Event listeners ----------

export const onLog = (cb: (l: LogLine) => void): Promise<UnlistenFn> =>
  listen<LogLine>("log", (e) => cb(e.payload));

export const onStatus = (cb: (s: Status) => void): Promise<UnlistenFn> =>
  listen<Status>("status", (e) => cb(e.payload));

export const onConnection = (cb: (c: ConnState) => void): Promise<UnlistenFn> =>
  listen<ConnState>("connection", (e) => cb(e.payload));

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("progress", (e) => cb(e.payload));

export const onFinished = (cb: (f: Finished) => void): Promise<UnlistenFn> =>
  listen<Finished>("finished", (e) => cb(e.payload));

/**
 * Native Tools menu picked a tool. Payload is the tool key ("testpattern",
 * "tepra") or "" to close the current tool.
 */
export const onToolSelected = (cb: (tool: string) => void): Promise<UnlistenFn> =>
  listen<string>("tool-selected", (e) => cb(e.payload));

/** Enable/disable the mode-specific native Tools menu items for the mode. */
export const setToolMenuMode = (isCameo: boolean): Promise<void> =>
  invoke("cmd_set_tool_menu_mode", { isCameo });
