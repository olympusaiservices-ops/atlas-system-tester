import type {
  Catalog,
  ConnectionState,
  RunRecord,
  TestPlan,
  RunIndexEntry,
  SafetyLevel,
} from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  catalog: () => req<Catalog>('/vapi/catalog'),
  connection: () => req<ConnectionState>('/vapi/connection'),
  connect: (payload: {
    adminEmail: string;
    adminPassword: string;
    appAuth: 'auto' | 'manual';
    totp?: string;
    clientId?: string;
    clientSecret?: string;
  }) =>
    req<ConnectionState>('/vapi/connect', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  startRun: (payload: {
    testIds?: string[];
    enabledSafety: SafetyLevel[];
    stopOnFailure?: boolean;
    planId?: string;
    planName?: string;
  }) =>
    req<{ runId: string; status: string }>('/vapi/run', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  abortRun: () => req<{ ok: boolean }>('/vapi/run/abort', { method: 'POST' }),
  currentRun: () => req<RunRecord>('/vapi/run/current'),

  listPlans: () => req<TestPlan[]>('/vapi/plans'),
  savePlan: (plan: Partial<TestPlan>) =>
    req<TestPlan>('/vapi/plans', { method: 'POST', body: JSON.stringify(plan) }),
  deletePlan: (id: string) =>
    req<{ ok: boolean }>(`/vapi/plans/${id}`, { method: 'DELETE' }),

  listRuns: () => req<RunIndexEntry[]>('/vapi/runs'),
  getRun: (id: string) => req<RunRecord>(`/vapi/runs/${id}`),
};

/** Subscribe to the live run event stream. Returns an unsubscribe function. */
export function streamRun(handlers: {
  onSnapshot?: (run: RunRecord) => void;
  onStart?: (run: RunRecord) => void;
  onResult?: (r: import('./types').TestResult) => void;
  onProgress?: (s: import('./types').RunSummary) => void;
  onDone?: (run: RunRecord) => void;
}): () => void {
  const es = new EventSource('/vapi/run/stream');
  const on = (name: string, fn?: (d: any) => void) => {
    if (fn) es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));
  };
  on('snapshot', handlers.onSnapshot);
  on('start', handlers.onStart);
  on('result', handlers.onResult);
  on('progress', handlers.onProgress);
  on('done', handlers.onDone);
  return () => es.close();
}
