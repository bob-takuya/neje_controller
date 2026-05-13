import { useEffect, useState } from "react";
import * as api from "../lib/api";

type Props = {
  connected: boolean;
};

const STEP_CHOICES = [0.1, 1, 5, 10, 50];
const FEED_MIN = 100;
const FEED_MAX = 6000;

export function JogPanel({ connected }: Props) {
  const [step, setStep] = useState(5);
  const [feed, setFeed] = useState(2000);
  const [busy, setBusy] = useState(false);

  const doJog = async (dx: number, dy: number) => {
    if (!connected || busy) return;
    setBusy(true);
    try {
      await api.jog(dx * step, dy * step, feed);
    } catch (_e) {
      // already logged via event
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcuts: arrow keys for XY, +/- for step, Escape to cancel jog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!connected) return;
      // Ignore if the user is typing.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          doJog(-1, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          doJog(1, 0);
          break;
        case "ArrowUp":
          e.preventDefault();
          doJog(0, 1);
          break;
        case "ArrowDown":
          e.preventDefault();
          doJog(0, -1);
          break;
        case "Escape":
          e.preventDefault();
          api.jogCancel();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, step, feed, busy]);

  return (
    <div className="panel jog-panel">
      <h3>Jog</h3>
      <div className="jog-grid">
        <div />
        <button disabled={!connected} onClick={() => doJog(0, 1)}>↑</button>
        <div />
        <button disabled={!connected} onClick={() => doJog(-1, 0)}>←</button>
        <button disabled={!connected} className="stop" onClick={() => api.jogCancel()}>
          ■
        </button>
        <button disabled={!connected} onClick={() => doJog(1, 0)}>→</button>
        <div />
        <button disabled={!connected} onClick={() => doJog(0, -1)}>↓</button>
        <div />
      </div>
      <div className="row">
        <label>Step:</label>
        <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
          {STEP_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s} mm
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Feed:</label>
        <input
          type="number"
          min={FEED_MIN}
          max={FEED_MAX}
          step={100}
          value={feed}
          onChange={(e) => setFeed(Math.max(FEED_MIN, Math.min(FEED_MAX, Number(e.target.value) || FEED_MIN)))}
        />
        <span className="muted">mm/min</span>
      </div>
      <div className="row">
        <button disabled={!connected} onClick={() => api.home()}>$H Home</button>
        <button disabled={!connected} onClick={() => api.unlock()}>$X Unlock</button>
      </div>
      <div className="row">
        <button disabled={!connected} onClick={() => api.feedHold()}>! Feed hold</button>
        <button disabled={!connected} onClick={() => api.cycleStart()}>~ Resume</button>
        <button disabled={!connected} className="danger" onClick={() => api.softReset()}>
          ⎋ Soft reset
        </button>
      </div>
      <div className="hint">Arrow keys jog, Esc cancels.</div>
    </div>
  );
}
