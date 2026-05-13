import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";

type Entry = api.LogLine & { ts: number };

type Props = {
  entries: Entry[];
};

export function LogView({ entries }: Props) {
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [sendBuf, setSendBuf] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (autoscroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [entries, autoscroll]);

  const sendRaw = async () => {
    if (!sendBuf.trim()) return;
    try {
      await api.sendLine(sendBuf);
      setSendBuf("");
    } catch {
      /* error already emitted */
    }
  };

  const filtered = filter === "all" ? entries : entries.filter((e) => e.level === filter);

  return (
    <div className="panel log-panel">
      <h3>Log</h3>
      <div className="row">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">all</option>
          <option value="tx">TX</option>
          <option value="rx">RX</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label className="chk">
          <input
            type="checkbox"
            checked={autoscroll}
            onChange={(e) => setAutoscroll(e.target.checked)}
          />
          autoscroll
        </label>
      </div>
      <div className="log">
        {filtered.map((e, i) => (
          <div key={i} className={`log-line l-${e.level}`}>
            <span className="lvl">{e.level.toUpperCase()}</span>
            <span className="msg">{e.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="row send-row">
        <input
          type="text"
          placeholder="send raw G-code (e.g. G0 X10 Y10)"
          value={sendBuf}
          onChange={(e) => setSendBuf(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendRaw();
          }}
        />
        <button onClick={sendRaw}>Send</button>
      </div>
    </div>
  );
}
