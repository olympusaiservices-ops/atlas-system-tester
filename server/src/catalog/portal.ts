import type { Suite, VarBag } from '../engine/types.js';
import { def } from './util.js';
import { unwrap, firstOf, assertList, tag } from '../engine/helpers.js';

// The Portal API is the BFF that fronts the Atlas Core admin portal. It is
// consumed with the admin user session: the admin user JWT authorizes both the
// user-context endpoints and the portal:admin-scoped ones. A plain user token
// might lack portal:admin, so admin-scoped probes tolerate a 403 as a wired-but-
// unauthorized outcome rather than a failure.
const capId =
  (...keys: string[]) =>
  (varName: string) =>
  (body: unknown, vars: VarBag) => {
    const data = unwrap(body);
    const id = firstOf(data, ...keys);
    if (id !== undefined) vars[varName] = id;
  };

export const portalSuites: Suite[] = [
  // ───────────────────────── Health ──────────────────────────────
  {
    id: 'portal.health',
    service: 'portal',
    name: 'Portal · Health',
    description: 'Liveness and aggregated downstream health.',
    tests: [
      def({
        id: 'portal.health.live',
        suite: 'portal.health',
        service: 'portal',
        name: 'Portal health',
        endpoint: 'GET /health',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health' },
      }),
      def({
        id: 'portal.health.services',
        suite: 'portal.health',
        service: 'portal',
        name: 'Downstream services health',
        endpoint: 'GET /health/services',
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/health/services' },
        // 503 when one or more downstream services are degraded; still wired.
        expect: [200, 503],
      }),
    ],
  },

  // ───────────────────────── Auth (BFF) ──────────────────────────
  {
    id: 'portal.auth',
    service: 'portal',
    name: 'Portal · Auth (BFF)',
    description:
      'The portal-api auth orchestration layer (deployment-notes §8.4/§9): ' +
      'cookie-session login/refresh fronting Identity, and the unwrapped /me.',
    tests: [
      def({
        id: 'portal.auth.login-invalid',
        suite: 'portal.auth',
        service: 'portal',
        name: 'Login rejects bad credentials',
        endpoint: 'POST /api/v1/auth/login',
        // Uses a nonexistent account so the real admin is never lockout-affected
        // (§4.1: 5 failures locks an existing account). Proves the BFF login route
        // fronts Identity and rejects unknown credentials without a side effect.
        safety: 'read',
        auth: 'none',
        req: () => ({
          method: 'POST',
          path: '/api/v1/auth/login',
          body: {
            email: `verify-nobody-${tag()}@example.com`,
            password: `verify-wrong-${tag()}`,
          },
        }),
        expect: [400, 401],
      }),
      def({
        id: 'portal.auth.me',
        suite: 'portal.auth',
        service: 'portal',
        name: 'Current user (single-wrapped)',
        endpoint: 'GET /api/v1/me',
        // Guards against the §9.2 double-wrap regression: the profile must sit at
        // data.email, not data.data.email. The BFF bridges the bearer token the
        // same way it bridges the session cookie.
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/api/v1/me' },
        assert: (body) => {
          const d: any = unwrap(body);
          if (!d || (!d.email && !d.id && !d.atlasUserId))
            return ['profile missing email/id'];
          if (d.data && (d.data.email || d.data.atlasUserId))
            return ['response is double-wrapped ({data:{data:{…}}}) — see §9.2'];
          return [];
        },
      }),
      def({
        id: 'portal.auth.refresh',
        suite: 'portal.auth',
        service: 'portal',
        name: 'Refresh without a session',
        endpoint: 'POST /api/v1/auth/refresh',
        // No refresh cookie is presented, so the route replies 401/400; this only
        // proves it is wired (a real refresh needs the httpOnly identity_refresh
        // cookie the browser flow sets).
        safety: 'read',
        auth: 'none',
        req: { method: 'POST', path: '/api/v1/auth/refresh', body: {} },
        expect: [200, 400, 401],
      }),
    ],
  },

  // ───────────────────────── Dashboard ───────────────────────────
  {
    id: 'portal.dashboard',
    service: 'portal',
    name: 'Portal · Dashboard',
    tests: [
      def({
        id: 'portal.dashboard.user',
        suite: 'portal.dashboard',
        service: 'portal',
        name: 'User dashboard',
        endpoint: 'GET /api/dashboard',
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/api/dashboard' },
      }),
      def({
        id: 'portal.dashboard.admin',
        suite: 'portal.dashboard',
        service: 'portal',
        name: 'Admin dashboard',
        endpoint: 'GET /api/dashboard/admin',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/dashboard/admin' },
        expect: [200, 403],
      }),
      def({
        id: 'portal.dashboard.system',
        suite: 'portal.dashboard',
        service: 'portal',
        name: 'System dashboard',
        endpoint: 'GET /api/dashboard/system',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/dashboard/system' },
        expect: [200, 403],
      }),
    ],
  },

  // ───────────────────────── Wizard (setup) ──────────────────────
  {
    id: 'portal.wizard',
    service: 'portal',
    name: 'Portal · Setup Wizard',
    description:
      'The system is already initialized, so these are mostly reachability; ' +
      'advance/complete/reset change global setup state and are opt-in.',
    tests: [
      def({
        id: 'portal.wizard.get',
        suite: 'portal.wizard',
        service: 'portal',
        name: 'Get wizard state',
        endpoint: 'GET /api/wizard',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/wizard' },
        expect: [200, 403],
      }),
      def({
        id: 'portal.wizard.advance',
        suite: 'portal.wizard',
        service: 'portal',
        name: 'Advance wizard step',
        endpoint: 'POST /api/wizard/advance',
        // Mutates global setup state.
        safety: 'system',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'POST', path: '/api/wizard/advance', body: {} },
        // 409 if already complete; 400 if step preconditions are unmet.
        expect: [200, 400, 403, 409],
      }),
      def({
        id: 'portal.wizard.complete',
        suite: 'portal.wizard',
        service: 'portal',
        name: 'Complete wizard',
        endpoint: 'POST /api/wizard/complete',
        safety: 'system',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'POST', path: '/api/wizard/complete', body: {} },
        expect: [200, 400, 403, 409],
      }),
      def({
        id: 'portal.wizard.reset',
        suite: 'portal.wizard',
        service: 'portal',
        name: 'Reset wizard',
        endpoint: 'POST /api/wizard/reset',
        safety: 'system',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'POST', path: '/api/wizard/reset', body: {} },
        expect: [200, 400, 403, 409],
      }),
    ],
  },

  // ───────────────────────── Preferences (self) ──────────────────
  {
    id: 'portal.preferences',
    service: 'portal',
    name: 'Portal · Preferences',
    description: 'Reversible self-service preference changes.',
    tests: [
      def({
        id: 'portal.preferences.get',
        suite: 'portal.preferences',
        service: 'portal',
        name: 'Get preferences',
        endpoint: 'GET /api/preferences',
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/api/preferences' },
      }),
      def({
        id: 'portal.preferences.patch',
        suite: 'portal.preferences',
        service: 'portal',
        name: 'Update preferences (theme)',
        endpoint: 'PATCH /api/preferences',
        safety: 'write-isolated',
        auth: 'user',
        req: { method: 'PATCH', path: '/api/preferences', body: { theme: 'dark' } },
        expect: [200, 204],
      }),
      def({
        id: 'portal.preferences.reset',
        suite: 'portal.preferences',
        service: 'portal',
        name: 'Reset preferences to default',
        endpoint: 'DELETE /api/preferences',
        safety: 'write-isolated',
        auth: 'user',
        req: { method: 'DELETE', path: '/api/preferences' },
        expect: [200, 204],
      }),
    ],
  },

  // ───────────────────────── Notifications (self) ────────────────
  {
    id: 'portal.notifications',
    service: 'portal',
    name: 'Portal · Notifications',
    tests: [
      def({
        id: 'portal.notifications.list',
        suite: 'portal.notifications',
        service: 'portal',
        name: 'List notifications',
        endpoint: 'GET /api/notifications',
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/api/notifications' },
        assert: assertList,
        // Capture the first notification id (if any) for the read/delete probes.
        capture: (body, vars) => {
          const list = unwrap(body);
          const first = Array.isArray(list) ? list[0] : undefined;
          const id = firstOf(first, 'id', 'notification_id');
          if (id !== undefined) vars.notifId = id;
        },
      }),
      def({
        id: 'portal.notifications.read',
        suite: 'portal.notifications',
        service: 'portal',
        name: 'Mark notification read',
        endpoint: 'PATCH /api/notifications/:id/read',
        safety: 'write-isolated',
        auth: 'user',
        requires: ['notifId'],
        req: () => ({ method: 'PATCH', path: '/api/notifications/{{notifId}}/read' }),
        expect: [200, 204, 404],
      }),
      def({
        id: 'portal.notifications.mark-all-read',
        suite: 'portal.notifications',
        service: 'portal',
        name: 'Mark all notifications read',
        endpoint: 'POST /api/notifications/mark-all-read',
        safety: 'write-isolated',
        auth: 'user',
        req: { method: 'POST', path: '/api/notifications/mark-all-read', body: {} },
        expect: [200, 204],
      }),
      def({
        id: 'portal.notifications.read-all',
        suite: 'portal.notifications',
        service: 'portal',
        name: 'Mark all read (PATCH alias)',
        endpoint: 'PATCH /api/notifications/read-all',
        // PATCH sibling of mark-all-read (both clear the unread state). Idempotent.
        safety: 'write-isolated',
        auth: 'user',
        req: { method: 'PATCH', path: '/api/notifications/read-all', body: {} },
        expect: [200, 204],
      }),
      def({
        id: 'portal.notifications.delete',
        suite: 'portal.notifications',
        service: 'portal',
        name: 'Delete notification',
        endpoint: 'DELETE /api/notifications/:id',
        safety: 'write-isolated',
        auth: 'user',
        requires: ['notifId'],
        req: () => ({ method: 'DELETE', path: '/api/notifications/{{notifId}}' }),
        expect: [200, 204, 404],
        capture: (_b, vars) => {
          delete vars.notifId;
        },
      }),
    ],
  },

  // ───────────────────────── Portal Config ───────────────────────
  {
    id: 'portal.config',
    service: 'portal',
    name: 'Portal · Config',
    tests: [
      def({
        id: 'portal.config.get',
        suite: 'portal.config',
        service: 'portal',
        name: 'Get portal config',
        endpoint: 'GET /api/config',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/config' },
        expect: [200, 403],
      }),
      def({
        id: 'portal.config.patch',
        suite: 'portal.config',
        service: 'portal',
        name: 'Update portal config (no-op)',
        endpoint: 'PATCH /api/config',
        // Mutates global portal config.
        safety: 'system',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'PATCH', path: '/api/config', body: {} },
        expect: [200, 204, 400, 403],
      }),
      def({
        id: 'portal.config.services',
        suite: 'portal.config',
        service: 'portal',
        name: 'Get service config',
        endpoint: 'GET /api/config/services',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/config/services' },
        expect: [200, 403],
      }),
      def({
        id: 'portal.config.base-url',
        suite: 'portal.config',
        service: 'portal',
        name: 'Set system base URL (M2M authority)',
        endpoint: 'PATCH /api/config/system-base-url',
        // Portal-api is the canonical base-URL authority (Option B): this writes
        // the base URL and fans it out to identity/email/app-store. It is an
        // internal M2M route (config:write app token), normally driven by
        // network→portal propagation. system-level + off by default; an empty
        // body avoids an actual change, and a missing scope yields 403.
        safety: 'system',
        auth: 'app',
        scopes: ['config:write'],
        req: { method: 'PATCH', path: '/api/config/system-base-url', body: {} },
        expect: [200, 204, 400, 403, 422],
      }),
    ],
  },

  // ───────────────────────── Activity ────────────────────────────
  {
    id: 'portal.activity',
    service: 'portal',
    name: 'Portal · Activity',
    tests: [
      def({
        id: 'portal.activity.all',
        suite: 'portal.activity',
        service: 'portal',
        name: 'Org activity feed',
        endpoint: 'GET /api/activity',
        safety: 'read',
        auth: 'user',
        scopes: ['portal:admin'],
        req: { method: 'GET', path: '/api/activity', query: { limit: '5' } },
        expect: [200, 403],
      }),
      def({
        id: 'portal.activity.mine',
        suite: 'portal.activity',
        service: 'portal',
        name: 'My activity feed',
        endpoint: 'GET /api/activity/mine',
        safety: 'read',
        auth: 'user',
        req: { method: 'GET', path: '/api/activity/mine', query: { limit: '5' } },
      }),
    ],
  },
];
