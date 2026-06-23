import path from 'node:path';

/**
 * Runtime configuration, resolved from environment variables. In-cluster the
 * Helm chart injects ATLAS_NAMESPACE and the service base URLs; locally these
 * can be overridden to point at port-forwards or the mock tester.
 */

const ns = process.env.ATLAS_NAMESPACE || 'atlas-core';

function svc(name: string): string {
  return `http://${name}.${ns}.svc.cluster.local`;
}

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
} as const;

export function endpointFor(service: keyof AtlasEndpoints): string {
  return config.endpoints[service];
}
