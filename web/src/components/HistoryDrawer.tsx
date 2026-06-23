import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RunIndexEntry, RunRecord } from '../types';

interface Props {
  onClose: () => void;
  onView: (run: RunRecord) => void;
}

export function HistoryDrawer({ onClose, onView }: Props) {
  const [runs, setRuns] = useState<RunIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listRuns()
      .then(setRuns)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="drawer" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2 style={{ margin: 0, flex: 1 }}>Run history</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <div className="scroll">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="empty">No past runs.</div>
          ) : (
            runs.map((r) => (
              <div
                className="list-item"
                key={r.id}
                onClick={async () => {
                  const full = await api.getRun(r.id);
                  onView(full);
                  onClose();
                }}
              >
                <div className="row">
                  <span style={{ flex: 1, fontWeight: 600 }}>{r.planName || r.id}</span>
                  <span className="small muted">{new Date(r.startedAt).toLocaleString()}</span>
                </div>
                <div className="row small mt">
                  <span className="pill pass">{r.summary.pass}</span>
                  <span className="pill fail">{r.summary.fail}</span>
                  <span className="pill error">{r.summary.error}</span>
                  <span className="pill skip">{r.summary.skip}</span>
                  <span className="muted">of {r.summary.total} · {r.status}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
