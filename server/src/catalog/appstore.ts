import type { Suite, VarBag } from '../engine/types.js';
import { def } from './util.js';
import {
  unwrap,
  firstOf,
  REACHABLE,
  assertList,
  tag,
} from '../engine/helpers.js';

// The app token used here carries the appstore:* scopes plus admin; per-test
// `scopes` are informational for the UI. Lifecycle endpoints that would deploy
// to the live cluster target a deliberately-nonexistent app_key and expect the
// REACHABLE set — proving route + auth + queueing are wired without installing
// anything real. write-isolated flows create their own resource and delete it.
const capId =
  (...keys: string[]) =>
  (varName: string) =>
  (body: unknown, vars: VarBag) => {
    const data = unwrap(body);
    const id = firstOf(data, ...keys);
    if (id !== undefined) vars[varName] = id;
  };

// Clearly-nonexistent app key. Targeting this proves the install/upgrade/
// uninstall routes are wired (auth + queueing) without deploying a real app;
// the cluster state is never altered.
const NONEXISTENT_APP = 'verify-nonexistent-app';

export const appstoreSuites: Suite[] = [
  // ───────────────────────── Health ──────────────────────────────
  {
    id: 'appstore.health',
    service: 'appstore',
    name: 'App Store · Health',
    description: 'Unauthenticated liveness + external dependency probes.',
    tests: [
      def({
        id: 'appstore.health.live',
        suite: 'appstore.health',
        service: 'appstore',
        name: 'Service health',
        endpoint: 'GET /health',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health' },
      }),
      def({
        id: 'appstore.health.commissioner',
        suite: 'appstore.health',
        service: 'appstore',
        name: 'Commissioner dependency health',
        endpoint: 'GET /health/commissioner',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health/commissioner' },
        // Commissioner is an external dependency; gateway errors when it is
        // offline still mean our route is reachable.
        expect: [200, 500, 502, 503, 504],
      }),
    ],
  },

  // ───────────────────────── Catalog ─────────────────────────────
  {
    id: 'appstore.catalog',
    service: 'appstore',
    name: 'App Store · Catalog',
    description: 'Browse the published app catalog.',
    tests: [
      def({
        id: 'appstore.catalog.list',
        suite: 'appstore.catalog',
        service: 'appstore',
        name: 'List catalog apps',
        endpoint: 'GET /api/v1/catalog/apps',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/catalog/apps', query: { pageSize: '5' } },
        assert: assertList,
        capture: (body, vars) => {
          const data = unwrap(body);
          const list = Array.isArray(data) ? data : [];
          for (const item of list) {
            const key = firstOf(item, 'app_key', 'appKey', 'key');
            if (key !== undefined) {
              vars.catalogAppKey = key;
              break;
            }
          }
        },
      }),
      def({
        id: 'appstore.catalog.get',
        suite: 'appstore.catalog',
        service: 'appstore',
        name: 'Get catalog app',
        endpoint: 'GET /api/v1/catalog/apps/:appKey',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        requires: ['catalogAppKey'],
        req: () => ({ method: 'GET', path: '/api/v1/catalog/apps/{{catalogAppKey}}' }),
        expect: [200, 404],
      }),
    ],
  },

  // ───────────────────────── Inventory ───────────────────────────
  {
    id: 'appstore.inventory',
    service: 'appstore',
    name: 'App Store · Inventory',
    description: 'Purchased, installed, and updatable apps.',
    tests: [
      def({
        id: 'appstore.inventory.purchased',
        suite: 'appstore.inventory',
        service: 'appstore',
        name: 'List purchased apps',
        endpoint: 'GET /api/v1/apps/purchased',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/apps/purchased' },
      }),
      def({
        id: 'appstore.inventory.installed',
        suite: 'appstore.inventory',
        service: 'appstore',
        name: 'List installed apps',
        endpoint: 'GET /api/v1/apps/installed',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/apps/installed' },
      }),
      def({
        id: 'appstore.inventory.updates',
        suite: 'appstore.inventory',
        service: 'appstore',
        name: 'List available updates',
        endpoint: 'GET /api/v1/apps/updates',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/apps/updates' },
      }),
      def({
        id: 'appstore.inventory.server-tarballs',
        suite: 'appstore.inventory',
        service: 'appstore',
        name: 'List server-staged tarballs',
        endpoint: 'GET /api/v1/apps/server-tarballs',
        // Sideload source discovery (spec §6.4): tarballs staged on the app-store
        // pod that a sideload can install from. Requires the install permission.
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:install'],
        req: { method: 'GET', path: '/api/v1/apps/server-tarballs' },
        expect: [200, 403],
      }),
    ],
  },

  // ───────────────────────── Purchases ───────────────────────────
  {
    id: 'appstore.purchases',
    service: 'appstore',
    name: 'App Store · Purchases',
    tests: [
      def({
        id: 'appstore.purchases.initiate',
        suite: 'appstore.purchases',
        service: 'appstore',
        name: 'Initiate purchase (reachability)',
        endpoint: 'POST /api/v1/purchases:initiate',
        // Redirects to an external checkout flow; opt-in only. Targets a
        // nonexistent app, so no real purchase is started.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:purchase:initiate'],
        req: { method: 'POST', path: '/api/v1/purchases:initiate', body: { app_key: NONEXISTENT_APP } },
        // Reachable set plus redirect statuses for the checkout hand-off.
        expect: [...REACHABLE, 200, 302, 303],
      }),
    ],
  },

  // ───────────────────────── Lifecycle ───────────────────────────
  {
    id: 'appstore.lifecycle',
    service: 'appstore',
    name: 'App Store · Lifecycle',
    description:
      'Install/upgrade/uninstall reachability. Targets a nonexistent app so the ' +
      'route + auth + queueing path is exercised without deploying to the cluster.',
    tests: [
      def({
        id: 'appstore.lifecycle.install',
        suite: 'appstore.lifecycle',
        service: 'appstore',
        name: 'Install app (reachability)',
        endpoint: 'POST /api/v1/apps/:appKey/install',
        // Targets NONEXISTENT_APP: proves the install route is wired without
        // actually deploying anything to the live cluster.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:install'],
        req: { method: 'POST', path: `/api/v1/apps/${NONEXISTENT_APP}/install`, body: { version: '1.0.0' } },
        expect: REACHABLE,
      }),
      def({
        id: 'appstore.lifecycle.upgrade',
        suite: 'appstore.lifecycle',
        service: 'appstore',
        name: 'Upgrade app (reachability)',
        endpoint: 'POST /api/v1/apps/:appKey/upgrade',
        // Targets NONEXISTENT_APP: proves the upgrade route is wired without
        // mutating any deployed app.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:upgrade'],
        req: { method: 'POST', path: `/api/v1/apps/${NONEXISTENT_APP}/upgrade`, body: { version: '1.0.1' } },
        expect: REACHABLE,
      }),
      def({
        id: 'appstore.lifecycle.uninstall',
        suite: 'appstore.lifecycle',
        service: 'appstore',
        name: 'Uninstall app (reachability)',
        endpoint: 'POST /api/v1/apps/:appKey/uninstall',
        // Targets NONEXISTENT_APP: proves the uninstall route is wired without
        // removing any deployed app.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:uninstall'],
        req: {
          method: 'POST',
          path: `/api/v1/apps/${NONEXISTENT_APP}/uninstall`,
          body: { keep_persistent_data: true },
        },
        expect: REACHABLE,
      }),
      def({
        id: 'appstore.lifecycle.sideload',
        suite: 'appstore.lifecycle',
        service: 'appstore',
        name: 'Sideload package (reachability)',
        endpoint: 'POST /api/v1/apps/sideload',
        // Enqueues an INSTALL/UPGRADE from an uploaded/staged package. Sending an
        // empty body carries no valid tarball, so validation rejects it (400/422)
        // — proving route + auth + validation are wired without installing anything.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:install'],
        req: { method: 'POST', path: '/api/v1/apps/sideload', body: {} },
        expect: REACHABLE,
      }),
      def({
        id: 'appstore.lifecycle.inspect',
        suite: 'appstore.lifecycle',
        service: 'appstore',
        name: 'Inspect package (reachability)',
        endpoint: 'POST /api/v1/apps/inspect',
        // Pre-sideload archive inspection (spec §6.4): validates a staged/uploaded
        // package against the release-package spec. An empty body references no
        // package, so validation rejects it (400/422) — proving route + auth +
        // validation are wired without inspecting anything real. Non-mutating.
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:install'],
        req: { method: 'POST', path: '/api/v1/apps/inspect', body: {} },
        expect: REACHABLE,
      }),
    ],
  },

  // ───────────────────────── Operations ──────────────────────────
  {
    id: 'appstore.operations',
    service: 'appstore',
    name: 'App Store · Operations',
    description: 'Async lifecycle operation tracking and logs.',
    tests: [
      def({
        id: 'appstore.operations.list',
        suite: 'appstore.operations',
        service: 'appstore',
        name: 'List operations',
        endpoint: 'GET /api/v1/operations',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/operations', query: { limit: '5' } },
        // capId's firstOf(data, ...) does data['id'], which is always
        // undefined when data is the array itself — this is a list endpoint,
        // so the id must come from its first item, not the array wrapper.
        capture: (body, vars) => {
          const data = unwrap(body) as any;
          const first = Array.isArray(data) ? data[0] : undefined;
          const id = firstOf(first, 'id', 'operation_id');
          if (id !== undefined) vars.operationId = id;
        },
      }),
      def({
        id: 'appstore.operations.get',
        suite: 'appstore.operations',
        service: 'appstore',
        name: 'Get operation',
        endpoint: 'GET /api/v1/operations/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        requires: ['operationId'],
        req: () => ({ method: 'GET', path: '/api/v1/operations/{{operationId}}' }),
      }),
      def({
        id: 'appstore.operations.logs',
        suite: 'appstore.operations',
        service: 'appstore',
        name: 'Get operation logs',
        endpoint: 'GET /api/v1/operations/:id/logs',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        requires: ['operationId'],
        req: () => ({ method: 'GET', path: '/api/v1/operations/{{operationId}}/logs' }),
      }),
    ],
  },

  // ───────────────────────── Pins ────────────────────────────────
  {
    id: 'appstore.pins',
    service: 'appstore',
    name: 'App Store · Pins',
    description: 'Pin/unpin apps for quick access.',
    tests: [
      def({
        id: 'appstore.pins.list',
        suite: 'appstore.pins',
        service: 'appstore',
        name: 'List pins',
        endpoint: 'GET /api/v1/pins',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/pins' },
      }),
      def({
        id: 'appstore.pins.create',
        suite: 'appstore.pins',
        service: 'appstore',
        name: 'Pin app',
        endpoint: 'POST /api/v1/pins',
        // Pins an existing core app — harmless, cleaned up below.
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'POST', path: '/api/v1/pins', body: { appKey: 'atlas-core-identity' } },
        expect: [200, 201, 409],
      }),
      def({
        id: 'appstore.pins.delete',
        suite: 'appstore.pins',
        service: 'appstore',
        name: 'Unpin app (cleanup)',
        endpoint: 'DELETE /api/v1/pins/:appKey',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'DELETE', path: '/api/v1/pins/atlas-core-identity' },
        expect: [200, 204, 404],
      }),
      def({
        id: 'appstore.pins.order',
        suite: 'appstore.pins',
        service: 'appstore',
        name: 'Reorder pins (persisted order)',
        endpoint: 'PUT /api/v1/pins/order',
        // Persists drag-and-drop pin ordering (spec §6.5/§7.8, pins.position). An
        // empty order is a safe no-op that still exercises the write path.
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'PUT', path: '/api/v1/pins/order', body: { order: [] } },
        expect: [200, 204, 400],
      }),
    ],
  },

  // ───────────────────────── Settings ────────────────────────────
  {
    id: 'appstore.settings',
    service: 'appstore',
    name: 'App Store · Settings',
    tests: [
      def({
        id: 'appstore.settings.get',
        suite: 'appstore.settings',
        service: 'appstore',
        name: 'Get settings',
        endpoint: 'GET /api/v1/settings',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/settings' },
      }),
      def({
        id: 'appstore.settings.put',
        suite: 'appstore.settings',
        service: 'appstore',
        name: 'Update settings (no-op)',
        endpoint: 'PUT /api/v1/settings',
        // Persists global app-store settings; opt-in only. Empty body is a no-op.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:telemetry:configure'],
        req: { method: 'PUT', path: '/api/v1/settings', body: {} },
        expect: [200, 204, 400],
      }),
      def({
        id: 'appstore.settings.base-url',
        suite: 'appstore.settings',
        service: 'appstore',
        name: 'Set system base URL (M2M receiver)',
        endpoint: 'PATCH /api/v1/settings/system-base-url',
        // Option B cross-service receiver: sets the org-wide base URL if the app
        // token carries config:write (usually not granted → 403). Empty body
        // avoids an actual change while proving route + auth.
        safety: 'system',
        auth: 'app',
        scopes: ['config:write'],
        req: { method: 'PATCH', path: '/api/v1/settings/system-base-url', body: {} },
        expect: [200, 204, 400, 403, 422],
      }),
    ],
  },

  // ───────────────────────── Telemetry ───────────────────────────
  {
    id: 'appstore.telemetry',
    service: 'appstore',
    name: 'App Store · Telemetry',
    tests: [
      def({
        id: 'appstore.telemetry.latest',
        suite: 'appstore.telemetry',
        service: 'appstore',
        name: 'Get latest telemetry',
        endpoint: 'GET /api/v1/telemetry/latest',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/telemetry/latest' },
        expect: [200, 404],
      }),
      def({
        id: 'appstore.telemetry.run',
        suite: 'appstore.telemetry',
        service: 'appstore',
        name: 'Run telemetry collection (reachability)',
        endpoint: 'POST /api/v1/telemetry:run',
        // Triggers a real telemetry collection job against the cluster; opt-in only.
        safety: 'system',
        auth: 'app',
        scopes: ['appstore:telemetry:configure'],
        req: { method: 'POST', path: '/api/v1/telemetry:run', body: {} },
        expect: REACHABLE,
      }),
    ],
  },

  // ───────────────────────── Audit ───────────────────────────────
  {
    id: 'appstore.audit',
    service: 'appstore',
    name: 'App Store · Audit',
    tests: [
      def({
        id: 'appstore.audit.events',
        suite: 'appstore.audit',
        service: 'appstore',
        name: 'Query audit events',
        endpoint: 'GET /api/v1/audit/events',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:audit:read'],
        req: { method: 'GET', path: '/api/v1/audit/events', query: { limit: '5' } },
      }),
    ],
  },

  // ───────────────────────── Third-Party ─────────────────────────
  {
    id: 'appstore.thirdparty',
    service: 'appstore',
    name: 'App Store · Third-Party',
    description: 'Full create→delete on a throwaway third-party app source.',
    tests: [
      def({
        id: 'appstore.thirdparty.list',
        suite: 'appstore.thirdparty',
        service: 'appstore',
        name: 'List third-party sources',
        endpoint: 'GET /api/v1/thirdparty',
        safety: 'read',
        auth: 'app',
        scopes: ['appstore:read'],
        req: { method: 'GET', path: '/api/v1/thirdparty' },
      }),
      def({
        id: 'appstore.thirdparty.create',
        suite: 'appstore.thirdparty',
        service: 'appstore',
        name: 'Register throwaway third-party source',
        endpoint: 'POST /api/v1/thirdparty',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['appstore:thirdparty:manage'],
        req: () => ({
          method: 'POST',
          path: '/api/v1/thirdparty',
          body: { name: `verify-tp-${tag()}`, launchUrl: 'https://example.com' },
        }),
        expect: [200, 201],
        capture: capId('id', 'thirdparty_id')('thirdPartyId'),
      }),
      def({
        id: 'appstore.thirdparty.delete',
        suite: 'appstore.thirdparty',
        service: 'appstore',
        name: 'Delete throwaway third-party source (cleanup)',
        endpoint: 'DELETE /api/v1/thirdparty/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['appstore:thirdparty:manage'],
        requires: ['thirdPartyId'],
        req: () => ({ method: 'DELETE', path: '/api/v1/thirdparty/{{thirdPartyId}}' }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.thirdPartyId;
        },
      }),
    ],
  },
];
