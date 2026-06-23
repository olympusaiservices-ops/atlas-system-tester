import type { FastifyInstance } from 'fastify';
import { ALL_SUITES, ALL_TESTS } from '../catalog/index.js';
import { auth } from '../atlas/auth.js';
import { runManager } from '../engine/manager.js';
import { config } from '../config.js';
import {
  listPlans,
  getPlan,
  savePlan,
  deletePlan,
  listRuns,
  getRun,
} from '../store/store.js';
import type { RunOptions, SafetyLevel } from '../engine/types.js';

const VALID_SAFETY: SafetyLevel[] = [
  'read',
  'write-isolated',
  'destructive',
  'system',
];

/** Serializable view of the catalog (strips request builder functions). */
function catalogView() {
  return {
    namespace: config.namespace,
    endpoints: config.endpoints,
    suites: ALL_SUITES.map((s) => ({
      id: s.id,
      service: s.service,
      name: s.name,
      description: s.description,
      tests: s.tests.map((t) => ({
        id: t.id,
        name: t.name,
        endpoint: t.endpoint,
        service: t.service,
        suite: t.suite,
        safety: t.safety,
        auth: t.auth,
        scopes: t.scopes || [],
      })),
    })),
    counts: {
      tests: ALL_TESTS.length,
      suites: ALL_SUITES.length,
      byService: countBy(ALL_TESTS.map((t) => t.service)),
      bySafety: countBy(ALL_TESTS.map((t) => t.safety)),
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

export async function registerApi(app: FastifyInstance) {
  // ---- Catalog ----
  app.get('/vapi/catalog', async () => catalogView());

  // ---- Connection ----
  app.get('/vapi/connection', async () => auth.getState());

  app.post('/vapi/connect', async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const adminEmail = String(body.adminEmail || '');
    const adminPassword = String(body.adminPassword || '');
    if (!adminEmail || !adminPassword) {
      return reply.code(400).send({ error: 'adminEmail and adminPassword are required' });
    }
    try {
      const state = await auth.connect({
        adminEmail,
        adminPassword,
        totp: body.totp ? String(body.totp) : undefined,
        appAuth: body.appAuth === 'manual' ? 'manual' : 'auto',
        clientId: body.clientId ? String(body.clientId) : undefined,
        clientSecret: body.clientSecret ? String(body.clientSecret) : undefined,
      });
      return state;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // ---- Runs ----
  app.post('/vapi/run', async (req, reply) => {
    if (!auth.getState().connected) {
      return reply.code(409).send({ error: 'Not connected. Connect to the cluster first.' });
    }
    if (runManager.active) {
      return reply.code(409).send({ error: 'A run is already in progress.' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const enabledSafety = sanitizeSafety(body.enabledSafety);
    const options: RunOptions = {
      testIds: Array.isArray(body.testIds)
        ? (body.testIds as unknown[]).map(String)
        : undefined,
      enabledSafety,
      stopOnFailure: Boolean(body.stopOnFailure),
    };
    const planMeta = {
      id: body.planId ? String(body.planId) : undefined,
      name: body.planName ? String(body.planName) : undefined,
    };
    const record = runManager.start(options, planMeta);
    return { runId: record.id, status: record.status };
  });

  app.post('/vapi/run/abort', async () => {
    runManager.abort();
    return { ok: true };
  });

  app.get('/vapi/run/current', async () => runManager.current() || { status: 'idle' });

  // Server-Sent Events stream of the active run.
  app.get('/vapi/run/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Replay the current run state so a late subscriber catches up.
    const current = runManager.current();
    if (current) send('snapshot', current);

    const unsubscribe = runManager.subscribe(send);
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ---- Plans ----
  app.get('/vapi/plans', async () => listPlans());
  app.get('/vapi/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await getPlan(id);
    return plan || reply.code(404).send({ error: 'plan not found' });
  });
  app.post('/vapi/plans', async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    if (!body.name) return reply.code(400).send({ error: 'name is required' });
    const plan = await savePlan({
      id: body.id ? String(body.id) : undefined,
      name: String(body.name),
      description: body.description ? String(body.description) : undefined,
      testIds: Array.isArray(body.testIds) ? (body.testIds as unknown[]).map(String) : [],
      enabledSafety: sanitizeSafety(body.enabledSafety),
      stopOnFailure: Boolean(body.stopOnFailure),
    });
    return plan;
  });
  app.delete('/vapi/plans/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ok = await deletePlan(id);
    return { ok };
  });

  // ---- Run history ----
  app.get('/vapi/runs', async () => listRuns());
  app.get('/vapi/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await getRun(id);
    return run || reply.code(404).send({ error: 'run not found' });
  });
}

function sanitizeSafety(input: unknown): SafetyLevel[] {
  const arr = Array.isArray(input) ? input.map(String) : [];
  const set = new Set<SafetyLevel>(['read']); // read is always implied
  for (const s of arr) {
    if (VALID_SAFETY.includes(s as SafetyLevel)) set.add(s as SafetyLevel);
  }
  return [...set];
}
