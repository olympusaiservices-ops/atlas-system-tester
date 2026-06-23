import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { registerApi } from './routes/api.js';

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
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

  // ---- Static SPA (built web app) ----
  const webDir = config.webDir;
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    // SPA fallback for client-side routes (but never for API/health/assets).
    app.setNotFoundHandler((req, reply) => {
      if (
        req.raw.url &&
        (req.raw.url.startsWith('/vapi') ||
          req.raw.url.startsWith('/health'))
      ) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`Web build not found at ${webDir}; UI will be unavailable.`);
    app.get('/', async () => ({
      app: 'atlas-varify',
      message: 'API is up; web UI build was not found.',
      api: '/vapi/catalog',
    }));
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `atlas-varify listening on ${config.host}:${config.port} (namespace=${config.namespace})`,
  );
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
