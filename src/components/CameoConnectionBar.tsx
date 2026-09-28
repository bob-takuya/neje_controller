import { useEffect, useState } from "react";
import * as api from "../lib/api";

type Props = {
  connected: boolean;
  /** Currently-connected device label (model + serial), if any. */
  connectedLabel: string | null;
};

/**
 * Connection bar for the Silhouette CAMEO 5. Unlike the GRBL ConnectionBar
 * (which lists serial ports + baud), the CAMEO is a raw-USB device, so we list
 * matching USB devices by VID/PID and connect by PID. No baud applies.
 */
export function CameoConnectionBar({ connected, connectedLabel }: Props) {
  const [devices, setDevices] = useState<api.CameoInfo[]>([]);
  const [selected, setSelected] = useState<string>(""); // "pid:bus:address"
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await api.cameoList();
      setDevices(list);
      if ((!selected || !list.some((d) => key(d) === selected)) && list.length > 0) {
        setSelected(key(list[0]));
      }
    } catch (e: any) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    const dev = devices.find((d) => key(d) === selected);
    if (!dev) return;
    setBusy(true);
    setErr(null);
    try {
      await api.cameoConnect(dev.pid, dev.bus, dev.address);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.cameoDisconnect();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-bar">
      <div className="row">
        <label>Cutter:</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={connected || busy}
        >
          {devices.length === 0 && <option value="">(no CAMEO found)</option>}
          {devices.map((d) => (
            <option key={key(d)} value={key(d)}>
              {d.model}
              {d.serial ? ` — ${d.serial}` : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={refresh} disabled={connected || busy}>
          ⟳
        </button>

        {connected ? (
          <>
            <span
              title="Connected over USB"
              style={{
                background: "#2f855a",
                color: "white",
                padding: "2px 8px",
                borderRadius: 4,
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              CAMEO
            </span>
            <button type="button" onClick={disconnect} disabled={busy} className="danger">
              Disconnect{connectedLabel ? ` (${connectedLabel})` : ""}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={connect}
            disabled={busy || !selected}
            className="primary"
          >
            Connect
          </button>
        )}
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

const key = (d: api.CameoInfo) => `${d.pid}:${d.bus}:${d.address}`;
