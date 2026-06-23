import type {
  TestCase,
  RequestSpec,
  VarBag,
  ServiceKey,
  SafetyLevel,
  AuthMode,
} from '../engine/types.js';

export interface Def {
  id: string;
  suite: string;
  name: string;
  endpoint: string;
  service: ServiceKey;
  safety: SafetyLevel;
  auth: AuthMode;
  scopes?: string[];
  /** Static request, or a builder that reads the run variable bag. */
  req: RequestSpec | ((v: VarBag) => RequestSpec);
  /** Accepted status codes. Defaults to [200]. */
  expect?: number[];
  /** Variable names required before this test runs (else it is skipped). */
  requires?: string[];
  capture?: (body: unknown, vars: VarBag) => void;
  assert?: (body: unknown, status: number, vars: VarBag) => string[];
}

/** Build a TestCase from a concise Def, filling defaults. */
export function def(d: Def): TestCase {
  const request =
    typeof d.req === 'function'
      ? (d.req as (v: VarBag) => RequestSpec)
      : () => d.req as RequestSpec;
  return {
    id: d.id,
    service: d.service,
    suite: d.suite,
    name: d.name,
    endpoint: d.endpoint,
    safety: d.safety,
    auth: d.auth,
    scopes: d.scopes,
    request,
    expectStatus: d.expect,
    requiresVars: d.requires,
    capture: d.capture,
    assert: d.assert,
  };
}
