import { useState } from 'react';
import type { Catalog, TestResult, Outcome } from '../types';

interface Props {
  catalog: Catalog;
  selected: Set<string>;
  results: Map<string, TestResult>;
  onToggleTest: (id: string) => void;
  onToggleSuite: (testIds: string[], on: boolean) => void;
}

const SERVICE_LABEL: Record<string, string> = {
  identity: 'Identity',
  email: 'Email',
  appstore: 'App Store',
  network: 'Network',
  portal: 'Portal',
};

function outcomeDot(o?: Outcome) {
  if (!o) return null;
  const color =
    o === 'pass' ? 'var(--green)' : o === 'fail' ? 'var(--red)' : o === 'error' ? 'var(--amber)' : 'var(--grey)';
  return <span className="dot" style={{ background: color }} title={o} />;
}

export function CatalogTree({ catalog, selected, results, onToggleTest, onToggleSuite }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <div>
      {catalog.suites.map((suite) => {
        const ids = suite.tests.map((t) => t.id);
        const selCount = ids.filter((id) => selected.has(id)).length;
        const allSel = selCount === ids.length;
        const isOpen = open[suite.id];
        return (
          <div className="suite" key={suite.id}>
            <div className="suite-head">
              <span className={`chev ${isOpen ? 'open' : ''}`} onClick={() => setOpen((o) => ({ ...o, [suite.id]: !o[suite.id] }))}>
                ▶
              </span>
              <input
                type="checkbox"
                checked={allSel}
                ref={(el) => {
                  if (el) el.indeterminate = selCount > 0 && !allSel;
                }}
                onChange={(e) => onToggleSuite(ids, e.target.checked)}
              />
              <span className="badge svc">{SERVICE_LABEL[suite.service] || suite.service}</span>
              <span className="name" onClick={() => setOpen((o) => ({ ...o, [suite.id]: !o[suite.id] }))}>
                {suite.name.replace(/^.*· /, '')}
              </span>
              <span className="suite-count">
                {selCount}/{ids.length}
              </span>
            </div>
            {isOpen &&
              suite.tests.map((t) => {
                const r = results.get(t.id);
                return (
                  <div className="test-row" key={t.id}>
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => onToggleTest(t.id)} />
                    {outcomeDot(r?.outcome)}
                    <span className="tname" title={t.endpoint}>
                      {t.name}
                    </span>
                    <span className={`badge ${t.safety}`}>{t.safety === 'write-isolated' ? 'write' : t.safety}</span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
