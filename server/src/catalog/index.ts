import type { Suite, TestCase } from '../engine/types.js';
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
