// Core domain model for the Atlas Verify test engine.

/** Which Atlas Core service a test targets. */
export type ServiceKey =
  | 'identity'
  | 'email'
  | 'appstore'
  | 'network'
  | 'portal';

/**
 * Safety classification. The runner only executes a test if the active run's
 * enabled safety levels include the test's level.
 *  - read            : GET / health / non-mutating. Always safe.
 *  - write-isolated  : creates a throwaway resource and cleans it up; never
 *                      touches pre-existing data.
 *  - destructive     : deletes or disables real resources, or mutates data that
 *                      is not freshly created by this run.
 *  - system          : changes global/system state (commissioner key, primary
 *                      domain, VPN enable/disable, wizard reset, app uninstall).
 */
export type SafetyLevel = 'read' | 'write-isolated' | 'destructive' | 'system';

/** Which credential a request is sent with. */
export type AuthMode =
  | 'none' // unauthenticated (public auth, health, jwks)
  | 'user' // user JWT (admin login)
  | 'app' // app/M2M JWT with scopes
  | 'refresh'; // uses the refresh cookie obtained at login

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path relative to the service base URL, may contain {{var}} placeholders. */
  path: string;
  query?: Record<string, string>;
  /** Static body, or a builder given the run context's variable bag. */
  body?: unknown | ((vars: VarBag) => unknown);
  headers?: Record<string, string>;
}

export interface TestContext {
  vars: VarBag;
}

export type VarBag = Record<string, unknown>;

/** A single endpoint exercise. */
export interface TestCase {
  /** Stable, unique id, e.g. "identity.users.create". */
  id: string;
  service: ServiceKey;
  /** Suite id this test belongs to, e.g. "identity.users". */
  suite: string;
  name: string;
  description?: string;
  /** The documented endpoint, for display: "POST /api/admin/users". */
  endpoint: string;
  safety: SafetyLevel;
  auth: AuthMode;
  /** Scopes the app token should carry for this call (informational/UI). */
  scopes?: string[];
  /** How to build the HTTP request. */
  request: (vars: VarBag) => RequestSpec;
  /** Accepted HTTP status codes for a pass. Defaults to [200]. */
  expectStatus?: number[];
  /**
   * Variable names this test needs in the bag before it can run. If any is
   * missing/undefined the test is skipped (its prerequisite failed).
   */
  requiresVars?: string[];
  /** Capture values from the response body into the run var bag. */
  capture?: (resBody: unknown, vars: VarBag) => void;
  /**
   * Extra assertions beyond status. Return human-readable failure messages;
   * an empty array means the assertions passed.
   */
  assert?: (resBody: unknown, status: number, vars: VarBag) => string[];
}

export interface Suite {
  id: string;
  service: ServiceKey;
  name: string;
  description?: string;
  tests: TestCase[];
}

// ---- Run-time result types -------------------------------------------------

export type TestOutcome = 'pass' | 'fail' | 'skip' | 'error';

export interface TestResult {
  testId: string;
  name: string;
  endpoint: string;
  service: ServiceKey;
  suite: string;
  safety: SafetyLevel;
  outcome: TestOutcome;
  status?: number;
  expected?: number[];
  durationMs: number;
  failures: string[]; // assertion failures / reasons
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
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
  status: 'running' | 'done' | 'aborted';
  options: RunOptions;
  summary: RunSummary;
  results: TestResult[];
}

/** Options chosen for a run (and persisted in a saved plan). */
export interface RunOptions {
  /** Test ids selected to run. Empty/undefined = all (subject to safety). */
  testIds?: string[];
  /** Safety levels permitted this run. 'read' is always implied. */
  enabledSafety: SafetyLevel[];
  /** Stop the run on the first failure. */
  stopOnFailure?: boolean;
}

/** A saved, reusable test plan persisted as JSON on the data volume. */
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
