import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ALL_SUITES, ALL_TESTS, resolveSelection } from '../catalog/index.js';
import { auth } from '../atlas/auth.js';
import { runManager } from '../engine/manager.js';
import { config } from '../config.js';
import { listRuns, getRun } from '../store/store.js';
import type { RunOptions, RunRecord, SafetyLevel } from '../engine/types.js';

/**
 * Headless, agent-facing API mounted under /agent. It mirrors the browser
 * `/vapi` surface but is optimised for a Claude instance driving the tester over
 * a kubectl port-forward: connect from env, run-and-wait for full JSON results,
 * and failures-only diagnostic views.
 *
 * When `config.agentToken` is set, every /agent request must present it; when it
 * is empty the API is open (safe only behind a localhost port-forward). The
 * browser SPA keeps using the unauthenticated /vapi routes untouched.
 */

const VALID_SAFETY: SafetyLevel[] = [
  'read',
  'write-isolated',
  'destructive',
  'system',
];

function sanitizeSafety(input: unknown): SafetyLevel[] {
  const arr = Array.isArray(input) ? input.map(String) : [];
  const set = new Set<SafetyLevel>(['read']); // read is always implied
  for (const s of arr) {
    if (VALID_SAFETY.includes(s as SafetyLevel)) set.add(s as SafetyLevel);
  }
  return [...set];
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

function catalogCounts() {
  return {
    tests: ALL_TESTS.length,
    suites: ALL_SUITES.length,
    byService: countBy(ALL_TESTS.map((t) => t.service)),
    bySafety: countBy(ALL_TESTS.map((t) => t.safety)),
  };
}

/** Lightweight status view of a run without the (large) results array. */
function runSummaryView(record: RunRecord) {
  return {
    id: record.id,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    summary: record.summary,
    planName: record.planName,
  };
}

/** Full run view, optionally trimmed to failing/errored results for diagnosis. */
function runView(record: RunRecord, failuresOnly: boolean) {
  if (!failuresOnly) return record;
  return {
    ...record,
    results: record.results.filter(
      (r) => r.outcome === 'fail' || r.outcome === 'error',
    ),
  };
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 'yes';
}

/** Constant-time token comparison that tolerates length differences. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function agentGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  if (!config.agentToken) return done(); // open (port-forward / in-cluster only)
  const hdr = req.headers['authorization'];
  const bearer =
    typeof hdr === 'string' && hdr.startsWith('Bearer ')
      ? hdr.slice(7)
      : undefined;
  const alt = req.headers['x-verify-token'];
  const provided = bearer || (typeof alt === 'string' ? alt : undefined);
  if (provided && tokenMatches(provided, config.agentToken)) return done();
  req.log.warn({ path: req.url }, 'agent.auth.reject');
  reply
    .code(401)
    .send({ error: 'unauthorized: missing or invalid agent token' });
}

export async function registerAgentApi(app: FastifyInstance) {
  await app.register(
    async (agent) => {
      // Encapsulated hook: applies only to routes registered in this plugin.
      agent.addHook('onRequest', agentGuard);

      // ── Orientation ────────────────────────────────────────────────────────
      agent.get('/info', async () => ({
        app: 'atlas-verify',
        version: config.version,
        namespace: config.namespace,
        endpoints: config.endpoints,
        authRequired: Boolean(config.agentToken),
        autoConnect: config.autoConnect,
        connection: auth.getState(),
        catalog: catalogCounts(),
        activeRun: runManager.active
          ? runSummaryView(runManager.current() as RunRecord)
          : null,
      }));

      // ── Catalog (compact; optional ?service= filter) ───────────────────────
      agent.get('/catalog', async (req) => {
        const service = (req.query as { service?: string })?.service;
        const suites = ALL_SUITES.filter(
          (s) => !service || s.service === service,
        );
        const tests = ALL_TESTS.filter((t) => !service || t.service === service);
        return {
          namespace: config.namespace,
          counts: catalogCounts(),
          suites: suites.map((s) => ({
            id: s.id,
            service: s.service,
            name: s.name,
            description: s.description,
            testIds: s.tests.map((t) => t.id),
          })),
          tests: tests.map((t) => ({
            id: t.id,
            name: t.name,
            endpoint: t.endpoint,
            service: t.service,
            suite: t.suite,
            safety: t.safety,
            auth: t.auth,
            scopes: t.scopes || [],
          })),
        };
      });

      // ── Connect (env creds by default, or explicit body) ───────────────────
      agent.post('/connect', async (req, reply) => {
        const body = (req.body || {}) as Record<string, unknown>;
        try {
          if (body.adminEmail && body.adminPassword) {
            return await auth.connect({
              adminEmail: String(body.adminEmail),
              adminPassword: String(body.adminPassword),
              totp: body.totp ? String(body.totp) : undefined,
              appAuth: body.appAuth === 'manual' ? 'manual' : 'auto',
              clientId: body.clientId ? String(body.clientId) : undefined,
              clientSecret: body.clientSecret
                ? String(body.clientSecret)
                : undefined,
            });
          }
          const state = await auth.ensureConnected();
          if (!state) {
            return reply.code(400).send({
              error:
                'No credentials provided and none configured (set VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD, or POST adminEmail/adminPassword).',
            });
          }
          return state;
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });

      // ── Run (defaults to wait=true → returns the finished record) ──────────
      agent.post('/run', async (req, reply) => {
        const body = (req.body || {}) as Record<string, unknown>;
        const query = (req.query || {}) as Record<string, unknown>;

        // Ensure we have credentials to run authenticated tests.
        if (!auth.getState().connected) {
          try {
            const state = await auth.ensureConnected();
            if (!state) {
              return reply.code(409).send({
                error:
                  'Not connected. POST /agent/connect first, or configure VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD.',
              });
            }
          } catch (err) {
            return reply
              .code(502)
              .send({ error: `connect failed: ${(err as Error).message}` });
          }
        }

        if (runManager.active) {
          return reply.code(409).send({ error: 'A run is already in progress.' });
        }

        const toStrArr = (v: unknown) =>
          Array.isArray(v) ? v.map(String) : undefined;
        const sel = {
          testIds: toStrArr(body.testIds),
          suiteIds: toStrArr(body.suiteIds),
          services: toStrArr(body.services),
        };
        const hasSelectors = Boolean(
          sel.testIds?.length || sel.suiteIds?.length || sel.services?.length,
        );

        let testIds: string[] | undefined;
        if (hasSelectors) {
          const resolved = resolveSelection(sel);
          if (resolved.testIds.length === 0) {
            return reply.code(400).send({
              error: 'Selection matched no tests.',
              unknown: resolved.unknown,
            });
          }
          testIds = resolved.testIds;
        } // else: undefined → run everything (subject to safety gate)

        const options: RunOptions = {
          testIds,
          enabledSafety: sanitizeSafety(body.enabledSafety),
          stopOnFailure: Boolean(body.stopOnFailure),
        };
        const planMeta = {
          id: body.planId ? String(body.planId) : undefined,
          name: body.planName ? String(body.planName) : undefined,
        };

        const wait = query.wait === undefined ? true : truthy(query.wait);
        const failuresOnly = truthy(body.failuresOnly) || truthy(query.failuresOnly);

        if (!wait) {
          const record = runManager.start(options, planMeta);
          return { runId: record.id, status: record.status };
        }
        const record = await runManager.startAndWait(options, planMeta);
        return runView(record, failuresOnly);
      });

      agent.get('/run/current', async () => {
        const current = runManager.current();
        return current ? runSummaryView(current) : { status: 'idle' };
      });

      agent.post('/run/abort', async () => {
        runManager.abort();
        return { ok: true };
      });

      // ── History ────────────────────────────────────────────────────────────
      agent.get('/runs', async () => listRuns());
      agent.get('/runs/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const query = (req.query || {}) as Record<string, unknown>;
        const run = await getRun(id);
        if (!run) return reply.code(404).send({ error: 'run not found' });
        if (query.view === 'summary') return runSummaryView(run);
        return runView(run, truthy(query.failuresOnly));
      });
    },
    { prefix: '/agent' },
  );
}
