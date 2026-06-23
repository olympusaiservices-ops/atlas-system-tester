// Mirrors the serializable shapes returned by the server's /vapi routes.

export type ServiceKey = 'identity' | 'email' | 'appstore' | 'network' | 'portal';
export type SafetyLevel = 'read' | 'write-isolated' | 'destructive' | 'system';
export type AuthMode = 'none' | 'user' | 'app' | 'refresh';
export type Outcome = 'pass' | 'fail' | 'skip' | 'error';

export interface TestMeta {
  id: string;
  name: string;
  endpoint: string;
  service: ServiceKey;
  suite: string;
  safety: SafetyLevel;
  auth: AuthMode;
  scopes: string[];
}

export interface SuiteMeta {
  id: string;
  service: ServiceKey;
  name: string;
  description?: string;
  tests: TestMeta[];
}

export interface Catalog {
  namespace: string;
  endpoints: Record<ServiceKey, string>;
  suites: SuiteMeta[];
  counts: {
    tests: number;
    suites: number;
    byService: Record<string, number>;
    bySafety: Record<string, number>;
  };
}

export interface ConnectionState {
  connected: boolean;
  adminEmail?: string;
  userId?: string;
  appId?: string;
  clientId?: string;
  appAuth: 'auto' | 'manual';
  scopesGranted?: string[];
  haveUserToken: boolean;
  haveAppToken: boolean;
  notes: string[];
}

export interface TestResult {
  testId: string;
  name: string;
  endpoint: string;
  service: ServiceKey;
  suite: string;
  safety: SafetyLevel;
  outcome: Outcome;
  status?: number;
  expected?: number[];
  durationMs: number;
  failures: string[];
  request?: { method: string; url: string; headers?: Record<string, string>; body?: unknown };
  response?: { status: number; headers?: Record<string, string>; body?: unknown };
  startedAt: string;
}

export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  error: number;
}

export interface RunRecord {
  id: string;
  planId?: string;
  planName?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'aborted' | 'idle';
  summary: RunSummary;
  results: TestResult[];
}

export interface TestPlan {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  testIds: string[];
  enabledSafety: SafetyLevel[];
  stopOnFailure?: boolean;
}

export interface RunIndexEntry {
  id: string;
  planName?: string;
  startedAt: string;
  finishedAt?: string;
  status: RunRecord['status'];
  summary: RunSummary;
}
