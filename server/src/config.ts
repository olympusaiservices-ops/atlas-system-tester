import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Runtime configuration, resolved from environment variables. In-cluster the
 * Helm chart injects ATLAS_NAMESPACE and the service base URLs; locally these
 * can be overridden to point at port-forwards or the mock tester.
 */

const ns = process.env.ATLAS_NAMESPACE || 'atlas-core';

function svc(name: string): string {
  return `http://${name}.${ns}.svc.cluster.local`;
}

/** Best-effort read of the VERSION file so /agent/info can report a version. */
function readVersion(): string {
  if (process.env.VARIFY_VERSION) return process.env.VARIFY_VERSION;
  for (const p of [
    path.resolve(process.cwd(), 'VERSION'),
    path.resolve(process.cwd(), '..', 'VERSION'),
  ]) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch {
      /* not found here */
    }
  }
  return '0.0.0';
}

const adminEmail = process.env.VARIFY_ADMIN_EMAIL || undefined;
const adminPassword = process.env.VARIFY_ADMIN_PASSWORD || undefined;

export interface AtlasEndpoints {
  identity: string;
  email: string;
  appstore: string;
  network: string;
  portal: string; // portal-api (BFF)
}

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  namespace: ns,
  /** Directory for saved plans + run history (mounted PVC in-cluster). */
  dataDir: process.env.VARIFY_DATA_DIR || '/data/atlas-varify',
  /** Where the built web SPA lives relative to the server dist. */
  webDir:
    process.env.VARIFY_WEB_DIR || path.resolve(process.cwd(), 'web', 'dist'),

  /**
   * Base URLs for each Atlas Core service. Defaults to in-cluster DNS but each
   * is individually overridable so the tester can run against port-forwards
   * during development.
   */
  endpoints: {
    identity: process.env.ATLAS_IDENTITY_URL || svc('atlas-core-identity'),
    email: process.env.ATLAS_EMAIL_URL || svc('atlas-core-email'),
    appstore: process.env.ATLAS_APPSTORE_URL || svc('atlas-core-app-store'),
    network: process.env.ATLAS_NETWORK_URL || svc('atlas-core-network'),
    portal: process.env.ATLAS_PORTAL_API_URL || svc('atlas-core-portal-api'),
  } as AtlasEndpoints,

  /** The app_key this tester registers itself under in Identity. */
  appKey: process.env.VARIFY_APP_KEY || 'atlas-varify',

  /** Release version, for /agent/info. */
  version: readVersion(),

  // ── Headless / agent access ────────────────────────────────────────────────
  /**
   * Bearer token guarding the /agent/* API. When set, every /agent request must
   * present it (Authorization: Bearer <token> or X-Varify-Token). When empty the
   * agent API is open — safe only behind a localhost port-forward or in-cluster.
   */
  agentToken: process.env.VARIFY_AGENT_TOKEN || undefined,
  /** Admin credentials used for headless auto-connect (see auth.ensureConnected). */
  adminEmail,
  adminPassword,
  /**
   * When true (or when both admin creds are present) the server connects to the
   * cluster at startup and lazily before agent runs, without a browser.
   */
  autoConnect:
    process.env.VARIFY_AUTO_CONNECT === 'true' ||
    Boolean(adminEmail && adminPassword),
} as const;

export function endpointFor(service: keyof AtlasEndpoints): string {
  return config.endpoints[service];
}
