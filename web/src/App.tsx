import { useEffect, useMemo, useRef, useState } from 'react';
import { api, streamRun } from './api';
import type {
  Catalog,
  ConnectionState,
  TestResult,
  RunSummary,
  TestPlan,
  SafetyLevel,
  Outcome,
  RunRecord,
} from './types';
import { ConnectionPanel } from './components/ConnectionPanel';
import { CatalogTree } from './components/CatalogTree';
import { ResultsPanel } from './components/ResultsPanel';
import { PlansPanel } from './components/PlansPanel';
import { HistoryDrawer } from './components/HistoryDrawer';

const EMPTY_SUMMARY: RunSummary = { total: 0, pass: 0, fail: 0, skip: 0, error: 0 };
const OPTIONAL_SAFETY: SafetyLevel[] = ['write-isolated', 'destructive', 'system'];
const SAFETY_LABEL: Record<SafetyLevel, string> = {
  read: 'Read-only',
  'write-isolated': 'Isolated writes',
  destructive: 'Destructive',
  system: 'System / global',
};

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  const [connError, setConnError] = useState<string>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [safety, setSafety] = useState<Set<SafetyLevel>>(new Set(['write-isolated']));
  const [stopOnFailure, setStopOnFailure] = useState(false);

  const [resultsArr, setResultsArr] = useState<TestResult[]>([]);
  const resultsMap = useMemo(() => new Map(resultsArr.map((r) => [r.testId, r])), [resultsArr]);
  const [summary, setSummary] = useState<RunSummary>(EMPTY_SUMMARY);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<Outcome | 'all'>('all');

  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingHistory, setViewingHistory] = useState<RunRecord | null>(null);

  const streamRef = useRef<(() => void) | null>(null);

  // Initial load.
  useEffect(() => {
    api.catalog().then((c) => {
      setCatalog(c);
      setSelected(new Set(c.suites.flatMap((s) => s.tests.map((t) => t.id))));
    });
    api.connection().then(setConn).catch(() => {});
    refreshPlans();
  }, []);

  // Persistent SSE subscription.
  useEffect(() => {
    streamRef.current = streamRun({
      onSnapshot: (run) => {
        if (run.status === 'running') {
          setRunning(true);
          setResultsArr(run.results || []);
          setSummary(run.summary);
        }
      },
      onStart: () => {
        setViewingHistory(null);
        setResultsArr([]);
        setSummary(EMPTY_SUMMARY);
        setRunning(true);
      },
      onResult: (r) => setResultsArr((prev) => [...prev, r]),
      onProgress: (s) => setSummary(s),
      onDone: (run) => {
        setRunning(false);
        setSummary(run.summary);
        refreshRunsAndPlans();
      },
    });
    return () => streamRef.current?.();
  }, []);

  const refreshPlans = () => api.listPlans().then(setPlans).catch(() => {});
  const refreshRunsAndPlans = () => {
    refreshPlans();
  };

  async function connect(payload: Parameters<typeof api.connect>[0]) {
    setConnBusy(true);
    setConnError(undefined);
    try {
      const state = await api.connect(payload);
      setConn(state);
    } catch (e) {
      setConnError((e as Error).message);
    } finally {
      setConnBusy(false);
    }
  }

  const allTestIds = useMemo(
    () => (catalog ? catalog.suites.flatMap((s) => s.tests.map((t) => t.id)) : []),
    [catalog],
  );

  function toggleTest(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleSuite(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });
  }
  function toggleSafety(level: SafetyLevel) {
    setSafety((prev) => {
      const next = new Set(prev);
      next.has(level) ? next.delete(level) : next.add(level);
      return next;
    });
  }

  const enabledSafety = useMemo<SafetyLevel[]>(() => ['read', ...safety], [safety]);

  async function run(allOverride = false) {
    if (!conn?.connected) {
      setConnError('Connect to the cluster before running.');
      return;
    }
    setViewingHistory(null);
    setResultsArr([]);
    setSummary(EMPTY_SUMMARY);
    setRunning(true);
    try {
      await api.startRun({
        testIds: allOverride ? undefined : [...selected],
        enabledSafety,
        stopOnFailure,
      });
    } catch (e) {
      setRunning(false);
      setConnError((e as Error).message);
    }
  }

  async function stop() {
    await api.abortRun();
  }

  async function savePlan(name: string) {
    await api.savePlan({
      name,
      testIds: [...selected],
      enabledSafety,
      stopOnFailure,
    });
    refreshPlans();
  }
  function loadPlan(p: TestPlan) {
    setSelected(new Set(p.testIds));
    setSafety(new Set(p.enabledSafety.filter((s) => s !== 'read')));
    setStopOnFailure(!!p.stopOnFailure);
  }
  async function deletePlan(id: string) {
    await api.deletePlan(id);
    refreshPlans();
  }
  function importPlan(p: Partial<TestPlan>) {
    if (Array.isArray(p.testIds)) setSelected(new Set(p.testIds));
    if (Array.isArray(p.enabledSafety)) setSafety(new Set(p.enabledSafety.filter((s) => s !== 'read')));
    if (typeof p.stopOnFailure === 'boolean') setStopOnFailure(p.stopOnFailure);
  }

  function viewHistory(run: RunRecord) {
    setViewingHistory(run);
    setResultsArr(run.results || []);
    setSummary(run.summary);
    setRunning(false);
  }

  if (!catalog) {
    return <div className="empty">Loading Atlas System Tester…</div>;
  }

  const dangerSelected = safety.has('destructive') || safety.has('system');

  return (
    <div className="app">
      <div className="topbar">
        <h1>
          <svg className="logo" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="7" fill="#1b2542" />
            <path d="M9 17.5l4.5 4.5L23 11" fill="none" stroke="#4ade80" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Atlas System Tester
        </h1>
        <span className="small muted">
          {catalog.counts.tests} tests · {catalog.counts.suites} suites · ns <b>{catalog.namespace}</b>
        </span>
        <div className="spacer" />
        <button className="ghost small" onClick={() => setShowHistory(true)}>History</button>
      </div>

      <div className="body">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="scroll pad">
            <ConnectionPanel state={conn} busy={connBusy} onConnect={connect} error={connError} />

            <div className="card">
              <h2>Safety scope</h2>
              <div className="row small" style={{ marginBottom: 6 }}>
                <span className="badge read">read</span>
                <span className="muted">always enabled</span>
              </div>
              {OPTIONAL_SAFETY.map((lvl) => (
                <label key={lvl} className="row" style={{ marginBottom: 4, cursor: 'pointer' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={safety.has(lvl)} onChange={() => toggleSafety(lvl)} />
                  <span className={`badge ${lvl}`}>{lvl === 'write-isolated' ? 'write' : lvl}</span>
                  <span className="small">{SAFETY_LABEL[lvl]}</span>
                </label>
              ))}
              <label className="row mt" style={{ cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={stopOnFailure} onChange={(e) => setStopOnFailure(e.target.checked)} />
                <span className="small">Stop on first failure</span>
              </label>
              {dangerSelected && (
                <div className="note warn">
                  Destructive / system tests change real cluster state. They run against throwaway or
                  clearly-nonexistent resources where possible, but enable with care.
                </div>
              )}
            </div>

            <PlansPanel
              plans={plans}
              selectedCount={selected.size}
              onSave={savePlan}
              onLoad={loadPlan}
              onDelete={deletePlan}
              onImport={importPlan}
              currentSelection={{ testIds: [...selected], enabledSafety, stopOnFailure }}
            />
          </div>

          <div className="tree-controls">
            <button className="small ghost" onClick={() => setSelected(new Set(allTestIds))}>Select all</button>
            <button className="small ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <span className="small muted" style={{ alignSelf: 'center' }}>{selected.size} selected</span>
          </div>
          <div className="scroll">
            <CatalogTree
              catalog={catalog}
              selected={selected}
              results={resultsMap}
              onToggleTest={toggleTest}
              onToggleSuite={toggleSuite}
            />
          </div>
        </div>

        {/* Main */}
        <div className="main">
          <div className="summary-bar" style={{ borderBottom: 'none', paddingBottom: 0 }}>
            <button className="primary" disabled={running || selected.size === 0} onClick={() => run(false)}>
              Run selected ({selected.size})
            </button>
            <button disabled={running} onClick={() => run(true)}>Run all</button>
            {running && <button className="danger" onClick={stop}>Stop</button>}
            <div className="spacer" style={{ flex: 1 }} />
            {viewingHistory && (
              <span className="small muted">
                viewing history: {viewingHistory.planName || viewingHistory.id}{' '}
                <button className="small ghost" onClick={() => { setViewingHistory(null); setResultsArr([]); setSummary(EMPTY_SUMMARY); }}>
                  back to live
                </button>
              </span>
            )}
          </div>
          <ResultsPanel results={resultsArr} summary={summary} running={running} filter={filter} onFilter={setFilter} />
        </div>
      </div>

      {showHistory && <HistoryDrawer onClose={() => setShowHistory(false)} onView={viewHistory} />}
    </div>
  );
}
