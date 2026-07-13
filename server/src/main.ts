import Fastify, { type FastifyBaseLogger } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { logger } from './log.js';
import { registerApi } from './routes/api.js';
import { registerAgentApi } from './routes/agent.js';
import { auth } from './atlas/auth.js';

async function main() {
  const app = Fastify({
    // Share one JSON logger with the engine so requests + run events + connect
    // attempts land on a single stdout stream (visible via `kubectl logs`).
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 5 * 1024 * 1024,
  });

  // ---- Health endpoints (UNAUTHENTICATED — required by the Atlas contract) ----
  // Keep these free of any auth so Kubernetes probes always reach them.
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    // The tester has no hard dependency to be "ready"; it is ready once the
    // process is serving. (It reaches Atlas services lazily during a run.)
    reply.code(200);
    return { status: 'ok' };
  });

  // ---- Tester API ----
  await registerApi(app);

  // ---- Headless agent API (/agent) ----
  await registerAgentApi(app);

  // ---- Static SPA (built web app) ----
  const webDir = config.webDir;
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    // SPA fallback for client-side routes (but never for API/health/assets).
    app.setNotFoundHandler((req, reply) => {
      if (
        req.raw.url &&
        (req.raw.url.startsWith('/vapi') ||
          req.raw.url.startsWith('/agent') ||
          req.raw.url.startsWith('/health'))
      ) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`Web build not found at ${webDir}; UI will be unavailable.`);
    app.get('/', async () => ({
      app: 'atlas-verify',
      message: 'API is up; web UI build was not found.',
      api: '/vapi/catalog',
    }));
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      namespace: config.namespace,
      agentAuth: Boolean(config.agentToken),
      autoConnect: config.autoConnect,
    },
    'atlas-verify listening',
  );

  // Best-effort headless connect at startup when admin creds are configured, so
  // a host-side agent can run tests immediately without a connect round-trip.
  if (config.autoConnect) {
    auth
      .ensureConnected()
      .then((state) => {
        if (state?.connected) {
          app.log.info(
            { userToken: state.haveUserToken, appToken: state.haveAppToken },
            'startup auto-connect succeeded',
          );
        } else {
          app.log.warn('startup auto-connect skipped: no credentials available');
        }
      })
      .catch((err) =>
        app.log.warn(
          { err: (err as Error).message },
          'startup auto-connect failed (will retry lazily on first run)',
        ),
      );
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
