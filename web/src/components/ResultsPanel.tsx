import { useState } from 'react';
import type { TestResult, RunSummary, Outcome } from '../types';

interface Props {
  results: TestResult[];
  summary: RunSummary;
  running: boolean;
  filter: Outcome | 'all';
  onFilter: (f: Outcome | 'all') => void;
}

function methodOf(endpoint: string): string {
  return endpoint.split(' ')[0] || 'GET';
}

function ResultRow({ r }: { r: TestResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="result-row">
      <div className="result-head" onClick={() => setOpen((o) => !o)}>
        <span className={`pill ${r.outcome}`}>{r.outcome}</span>
        <span className="badge method">{methodOf(r.endpoint)}</span>
        <span className="rname">{r.name}</span>
        <span className="ep mono">{r.endpoint.replace(/^\S+ /, '')}</span>
        {typeof r.status === 'number' && r.status > 0 && (
          <span className="mono muted">{r.status}</span>
        )}
        <span className="latency">{r.durationMs}ms</span>
      </div>
      {open && (
        <div className="detail">
          {r.failures.length > 0 && (
            <ul className="fail-list">
              {r.failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          <div className="small muted">
            {r.service} · {r.suite} · safety: {r.safety} · expected: {(r.expected || []).join(', ') || '—'}
          </div>
          {r.request && (
            <>
              <div className="small muted mt">Request</div>
              <pre className="mono">
                {r.request.method} {r.request.url}
                {r.request.body !== undefined ? '\n\n' + JSON.stringify(r.request.body, null, 2) : ''}
              </pre>
            </>
          )}
          {r.response && (
            <>
              <div className="small muted mt">Response ({r.response.status})</div>
              <pre className="mono">{JSON.stringify(r.response.body, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsPanel({ results, summary, running, filter, onFilter }: Props) {
  const shown = filter === 'all' ? results : results.filter((r) => r.outcome === filter);
  const pct = (n: number) => (summary.total ? (n / summary.total) * 100 : 0);

  return (
    <>
      <div className="summary-bar">
        <div className="progress">
          <span style={{ width: pct(summary.pass) + '%', background: 'var(--green)' }} />
          <span style={{ width: pct(summary.fail) + '%', background: 'var(--red)' }} />
          <span style={{ width: pct(summary.error) + '%', background: 'var(--amber)' }} />
          <span style={{ width: pct(summary.skip) + '%', background: 'var(--grey)' }} />
        </div>
        <FilterChip label="All" count={summary.total} active={filter === 'all'} onClick={() => onFilter('all')} />
        <FilterChip label="Pass" count={summary.pass} active={filter === 'pass'} onClick={() => onFilter('pass')} cls="pass" />
        <FilterChip label="Fail" count={summary.fail} active={filter === 'fail'} onClick={() => onFilter('fail')} cls="fail" />
        <FilterChip label="Error" count={summary.error} active={filter === 'error'} onClick={() => onFilter('error')} cls="error" />
        <FilterChip label="Skip" count={summary.skip} active={filter === 'skip'} onClick={() => onFilter('skip')} cls="skip" />
        {running && <span className="small muted">running…</span>}
      </div>
      <div className="scroll">
        {shown.length === 0 ? (
          <div className="empty">
            {results.length === 0 ? 'No results yet. Connect, choose tests, and run.' : 'No results match this filter.'}
          </div>
        ) : (
          shown.map((r) => <ResultRow key={r.testId} r={r} />)
        )}
      </div>
    </>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  cls,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  cls?: string;
}) {
  return (
    <button className={`small ${active ? 'primary' : 'ghost'}`} onClick={onClick}>
      <span className={cls ? `pill ${cls}` : ''} style={{ marginRight: 4 }}>
        {count}
      </span>
      {label}
    </button>
  );
}
