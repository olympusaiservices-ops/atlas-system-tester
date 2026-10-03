import pino from 'pino';

/**
 * One shared pino logger used by Fastify (HTTP request logging) and the test
 * engine (run lifecycle logs). A single JSON stream on stdout means everything
 * — requests, connect attempts, and per-test results — is visible together via
 * `kubectl logs deploy/atlas-system-tester`.
 *
 * Structured run events emitted by the engine:
 *   run.start   { runId, total, selection }
 *   run.result  { runId, testId, service, outcome, status, durationMs }  (info on fail/error, debug on pass)
 *   run.done    { runId, status, summary }
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { app: 'atlas-system-tester' },
});

export type Logger = typeof logger;
