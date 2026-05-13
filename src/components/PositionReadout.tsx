import * as api from "../lib/api";

type Props = {
  status: api.Status | null;
  connected: boolean;
};

const fmt = (n: number | undefined | null, d = 3) =>
  n == null ? "—" : n.toFixed(d);

export function PositionReadout({ status, connected }: Props) {
  const [mx, my, mz] = status?.mpos ?? [null, null, null];
  const [wx, wy, wz] = status?.wpos ?? [null, null, null];

  const stateClass = (status?.state ?? "").toLowerCase();

  return (
    <div className="panel pos-panel">
      <div className="row">
        <h3 style={{ margin: 0 }}>Status</h3>
        <span className={`state state-${stateClass || "unknown"}`}>
          {connected ? status?.state ?? "…" : "disconnected"}
        </span>
        <button disabled={!connected} onClick={() => api.pollStatus()}>
          ? poll
        </button>
      </div>
      <div className="pos-grid">
        <div>
          <label>MPos</label>
          <span>X {fmt(mx)}</span>
          <span>Y {fmt(my)}</span>
          <span>Z {fmt(mz)}</span>
        </div>
        <div>
          <label>WPos</label>
          <span>X {fmt(wx)}</span>
          <span>Y {fmt(wy)}</span>
          <span>Z {fmt(wz)}</span>
        </div>
        <div>
          <label>Feed / S</label>
          <span>F {fmt(status?.feed, 0)}</span>
          <span>S {fmt(status?.spindle, 0)}</span>
          <span />
        </div>
      </div>
    </div>
  );
}
