import type { ServiceKey, Suite, TestCase } from '../engine/types.js';
import { identitySuites, identityTeardownSuites } from './identity.js';
import { emailSuites } from './email.js';
import { appstoreSuites } from './appstore.js';
import { networkSuites } from './network.js';
import { portalSuites } from './portal.js';

/**
 * All suites, in deterministic execution order (service by service). The
 * identity teardown suite (logout) is appended last so it cannot revoke the
 * session before token-dependent tests in other services have run.
 */
export const ALL_SUITES: Suite[] = [
  ...identitySuites,
  ...emailSuites,
  ...appstoreSuites,
  ...networkSuites,
  ...portalSuites,
  ...identityTeardownSuites,
];

/** Flat list of every test, in catalog order. */
export const ALL_TESTS: TestCase[] = ALL_SUITES.flatMap((s) => s.tests);

const TEST_BY_ID = new Map(ALL_TESTS.map((t) => [t.id, t]));

export function testById(id: string): TestCase | undefined {
  return TEST_BY_ID.get(id);
}

/**
 * Resolve a selection of test ids (or "all") into the ordered subset to run.
 * Selection order is ignored; catalog order is preserved so lifecycle steps
 * (create → read → update → delete) execute correctly.
 */
export function selectTests(testIds?: string[]): TestCase[] {
  if (!testIds || testIds.length === 0) return ALL_TESTS;
  const wanted = new Set(testIds);
  return ALL_TESTS.filter((t) => wanted.has(t.id));
}

const SUITE_IDS = new Set(ALL_SUITES.map((s) => s.id));

export interface Selection {
  /** Exact test ids. */
  testIds?: string[];
  /** Suite ids — expanded to every test in the suite. */
  suiteIds?: string[];
  /** Service keys — expanded to every test for that service. */
  services?: string[];
}

/** Report which requested selectors matched nothing, for caller feedback. */
export interface SelectionResult {
  testIds: string[];
  unknown: { testIds: string[]; suiteIds: string[]; services: string[] };
}

/**
 * Expand a mixed selection (test ids, suite ids, service keys) into a set of
 * concrete test ids. The engine still runs them in catalog order, preserving
 * create→read→update→delete lifecycle ordering regardless of selection order.
 * An empty selection means "everything".
 */
export function resolveSelection(sel: Selection): SelectionResult {
  const wanted = new Set<string>();
  const unknown = { testIds: [] as string[], suiteIds: [] as string[], services: [] as string[] };

  for (const id of sel.testIds || []) {
    if (TEST_BY_ID.has(id)) wanted.add(id);
    else unknown.testIds.push(id);
  }
  for (const suiteId of sel.suiteIds || []) {
    if (!SUITE_IDS.has(suiteId)) {
      unknown.suiteIds.push(suiteId);
      continue;
    }
    for (const t of ALL_TESTS) if (t.suite === suiteId) wanted.add(t.id);
  }
  for (const service of sel.services || []) {
    const matches = ALL_TESTS.filter((t) => t.service === (service as ServiceKey));
    if (matches.length === 0) unknown.services.push(service);
    for (const t of matches) wanted.add(t.id);
  }

  // Emit in catalog order.
  const testIds = ALL_TESTS.filter((t) => wanted.has(t.id)).map((t) => t.id);
  return { testIds, unknown };
}
