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

// ---------- Commands ----------

export const listPorts = (onlyLikely = true): Promise<PortInfo[]> =>
  invoke("cmd_list_ports", { onlyLikely });

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
