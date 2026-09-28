import { useEffect, useState } from "react";
import * as api from "../lib/api";

type Props = {
  connected: boolean;
  connectedPort: string | null;
  connKind?: api.PortKind;
  onConnectedChange?: (c: api.ConnState) => void;
};

const BAUD_CHOICES = [115200, 250000, 500000, 57600, 38400, 19200, 9600];

const kindLabel: Record<api.PortKind, string> = {
  esp: "ESP Proxy",
  direct: "Direct (NEJE)",
  unknown: "Unknown",
};
const kindStyle: Record<api.PortKind, React.CSSProperties> = {
  esp: { background: "#2b6cb0", color: "white" },
  direct: { background: "#2f855a", color: "white" },
  unknown: { background: "#718096", color: "white" },
};

export function ConnectionBar({ connected, connectedPort, connKind = "unknown" }: Props) {
  const [ports, setPorts] = useState<api.PortInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [baud, setBaud] = useState<number>(115200);
  const [onlyLikely, setOnlyLikely] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await api.listPorts(onlyLikely);
      setPorts(list);
      if (!selected && list.length > 0) setSelected(list[0].name);
    } catch (e: any) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyLikely]);

  const connect = async () => {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      await api.connect(selected, baud);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnect();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connection-bar">
      <div className="row">
        <label>Port:</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={connected || busy}
        >
          {ports.length === 0 && <option value="">(no ports)</option>}
          {ports.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.manufacturer ? ` — ${p.manufacturer}` : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={refresh} disabled={connected || busy}>
          ⟳
        </button>
        <label className="chk">
          <input
            type="checkbox"
            checked={onlyLikely}
            onChange={(e) => setOnlyLikely(e.target.checked)}
            disabled={connected || busy}
          />
          filter likely
        </label>

        <label>Baud:</label>
        <select
          value={baud}
          onChange={(e) => setBaud(Number(e.target.value))}
          disabled={connected || busy}
        >
          {BAUD_CHOICES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>

        {connected ? (
          <>
            <span
              title={`Currently connected as ${kindLabel[connKind]}`}
              style={{
                ...kindStyle[connKind],
                padding: "2px 8px",
                borderRadius: 4,
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              {kindLabel[connKind]}
            </span>
            <button type="button" onClick={disconnect} disabled={busy} className="danger">
              Disconnect{connectedPort ? ` (${connectedPort})` : ""}
            </button>
          </>
        ) : (
          <button type="button" onClick={connect} disabled={busy || !selected} className="primary">
            Connect
          </button>
        )}
      </div>
      {err && <div className="err">{err}</div>}
    </div>
  );
}
