import type { Suite, VarBag } from '../engine/types.js';
import { def } from './util.js';
import {
  unwrap,
  firstOf,
  REACHABLE,
  assertList,
  tag,
} from '../engine/helpers.js';

// Throwaway resource namespace. Nothing here touches pre-existing data; every
// write-isolated flow creates its own resource and deletes it again.
const capId =
  (...keys: string[]) =>
  (varName: string) =>
  (body: unknown, vars: VarBag) => {
    const data = unwrap(body);
    const id = firstOf(data, ...keys);
    if (id !== undefined) vars[varName] = id;
  };

// Endpoints that touch live network/cluster fabric (Cloudflare tunnels, mesh
// pings) can fail at the upstream while still being correctly wired; treat
// gateway errors as "reachable", not a failure.
const FABRIC_REACHABLE = [...REACHABLE, 500, 502, 503];

export const networkSuites: Suite[] = [
  // ───────────────────────── Health ──────────────────────────────
  {
    id: 'network.health',
    service: 'network',
    name: 'Network · Health',
    description: 'Liveness and Cloudflare connectivity probes.',
    tests: [
      def({
        id: 'network.health.live',
        suite: 'network.health',
        service: 'network',
        name: 'Service health',
        endpoint: 'GET /health',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health' },
      }),
      def({
        id: 'network.health.cloudflare',
        suite: 'network.health',
        service: 'network',
        name: 'Cloudflare connectivity',
        endpoint: 'GET /health/cloudflare',
        safety: 'read',
        auth: 'none',
        // External upstream; gateway errors when offline are tolerated.
        req: { method: 'GET', path: '/health/cloudflare' },
        expect: [200, 500, 502, 503, 504],
      }),
    ],
  },

  // ───────────────────────── Tunnels ─────────────────────────────
  {
    id: 'network.tunnels',
    service: 'network',
    name: 'Network · Tunnels',
    description: 'Full create→read→update→activate→delete on a throwaway tunnel.',
    tests: [
      def({
        id: 'network.tunnels.list',
        suite: 'network.tunnels',
        service: 'network',
        name: 'List tunnels',
        endpoint: 'GET /api/tunnels',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/tunnels' },
        assert: assertList,
      }),
      def({
        id: 'network.tunnels.create',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Create throwaway proxy (Cloudflare)',
        endpoint: 'POST /api/tunnels',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        // A "tunnel" is now a network proxy with a provider + provider-specific
        // config; the service derives the hostname/public URL from that config.
        // Created inactive, so it never becomes the system base URL until it is
        // explicitly activated (a separate, system-level step below).
        req: () => ({
          method: 'POST',
          path: '/api/tunnels',
          body: {
            name: `verify-tunnel-${tag()}`,
            provider: 'cloudflare',
            config: {
              mode: 'token',
              publicHostname: `verify-${tag()}.example.com`,
              originService: 'http://localhost:8080',
              tunnelToken: `verify-fake-${tag()}`,
            },
          },
        }),
        expect: [200, 201],
        capture: capId('id', 'tunnel_id')('tunnelId'),
      }),
      def({
        id: 'network.tunnels.get',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Get throwaway tunnel',
        endpoint: 'GET /api/tunnels/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        requires: ['tunnelId'],
        req: () => ({ method: 'GET', path: '/api/tunnels/{{tunnelId}}' }),
      }),
      def({
        id: 'network.tunnels.update',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Update throwaway proxy (secret preserved)',
        endpoint: 'PATCH /api/tunnels/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['tunnelId'],
        // PATCH merges provider_config over the stored config and preserves the
        // secret when the incoming value is blank — exercise that path (blank
        // tunnelToken keeps the one set at create) alongside a name change.
        req: () => ({
          method: 'PATCH',
          path: '/api/tunnels/{{tunnelId}}',
          body: { name: 'verify-tunnel-upd', config: { tunnelToken: '' } },
        }),
        expect: [200],
      }),
      def({
        id: 'network.tunnels.activate',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Activate proxy (single-active + base URL)',
        endpoint: 'POST /api/tunnels/:id/activate',
        // Provisions the proxy against its provider AND makes its public URL the
        // system base URL: deactivates every other proxy and fans the new base
        // URL out to portal-api → identity/email/app-store (Option B). A live
        // fabric + global-state change, so system-level and off by default.
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['tunnelId'],
        req: () => ({ method: 'POST', path: '/api/tunnels/{{tunnelId}}/activate' }),
        expect: FABRIC_REACHABLE,
      }),
      def({
        id: 'network.tunnels.deactivate',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Deactivate tunnel',
        endpoint: 'POST /api/tunnels/:id/deactivate',
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['tunnelId'],
        req: () => ({ method: 'POST', path: '/api/tunnels/{{tunnelId}}/deactivate' }),
        expect: FABRIC_REACHABLE,
      }),
      def({
        id: 'network.tunnels.delete',
        suite: 'network.tunnels',
        service: 'network',
        name: 'Delete throwaway tunnel (cleanup)',
        endpoint: 'DELETE /api/tunnels/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['tunnelId'],
        req: () => ({ method: 'DELETE', path: '/api/tunnels/{{tunnelId}}' }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.tunnelId;
        },
      }),
    ],
  },

  // ───────────────────────── DNS ─────────────────────────────────
  {
    id: 'network.dns',
    service: 'network',
    name: 'Network · DNS',
    description: 'Zone listing plus a throwaway TXT record lifecycle.',
    tests: [
      def({
        id: 'network.dns.zones-list',
        suite: 'network.dns',
        service: 'network',
        name: 'List DNS zones',
        endpoint: 'GET /api/dns/zones',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/dns/zones' },
        assert: assertList,
        capture: (body, vars) => {
          const data = unwrap(body);
          const first = Array.isArray(data) ? data[0] : undefined;
          const id = firstOf(first, 'id', 'zone_id');
          if (id !== undefined) vars.zoneId = id;
        },
      }),
      def({
        id: 'network.dns.records-list',
        suite: 'network.dns',
        service: 'network',
        name: 'List zone records',
        endpoint: 'GET /api/dns/zones/:zoneId/records',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        requires: ['zoneId'],
        req: () => ({ method: 'GET', path: '/api/dns/zones/{{zoneId}}/records' }),
      }),
      def({
        id: 'network.dns.record-create',
        suite: 'network.dns',
        service: 'network',
        name: 'Create throwaway TXT record',
        endpoint: 'POST /api/dns/zones/:zoneId/records',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['zoneId'],
        req: () => ({
          method: 'POST',
          path: '/api/dns/zones/{{zoneId}}/records',
          body: {
            type: 'TXT',
            name: `verify-${tag()}`,
            content: 'verify-probe',
            ttl: 300,
          },
        }),
        expect: [200, 201, 400],
        capture: capId('id', 'record_id')('recordId'),
      }),
      def({
        id: 'network.dns.record-update',
        suite: 'network.dns',
        service: 'network',
        name: 'Update throwaway TXT record',
        endpoint: 'PATCH /api/dns/zones/:zoneId/records/:recordId',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['zoneId', 'recordId'],
        req: () => ({
          method: 'PATCH',
          path: '/api/dns/zones/{{zoneId}}/records/{{recordId}}',
          body: { content: 'verify-updated' },
        }),
        expect: [200],
      }),
      def({
        id: 'network.dns.record-delete',
        suite: 'network.dns',
        service: 'network',
        name: 'Delete throwaway TXT record (cleanup)',
        endpoint: 'DELETE /api/dns/zones/:zoneId/records/:recordId',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['zoneId', 'recordId'],
        req: () => ({
          method: 'DELETE',
          path: '/api/dns/zones/{{zoneId}}/records/{{recordId}}',
        }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.recordId;
        },
      }),
    ],
  },

  // ───────────────────────── VPN Config ──────────────────────────
  {
    id: 'network.vpn-config',
    service: 'network',
    name: 'Network · VPN Config',
    description: 'WireGuard server config: read state, rotate keys, enable/disable.',
    tests: [
      def({
        id: 'network.vpn-config.get',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Get VPN config',
        endpoint: 'GET /api/vpn/config',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/vpn/config' },
      }),
      def({
        id: 'network.vpn-config.status',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Get VPN config status',
        endpoint: 'GET /api/vpn/config/status',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/vpn/config/status' },
      }),
      def({
        id: 'network.vpn-config.generate-keys',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Generate WireGuard keys',
        endpoint: 'POST /api/vpn/config/generate-keys',
        // Rotates the WireGuard server keypair — a live fabric change.
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        req: { method: 'POST', path: '/api/vpn/config/generate-keys', body: {} },
        expect: REACHABLE,
      }),
      def({
        id: 'network.vpn-config.patch',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Update VPN config (no-op)',
        endpoint: 'PATCH /api/vpn/config',
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        req: { method: 'PATCH', path: '/api/vpn/config', body: {} },
        expect: [200, 204, 400],
      }),
      def({
        id: 'network.vpn-config.enable',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Enable VPN',
        endpoint: 'POST /api/vpn/config/enable',
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        req: { method: 'POST', path: '/api/vpn/config/enable', body: {} },
        expect: REACHABLE,
      }),
      def({
        id: 'network.vpn-config.disable',
        suite: 'network.vpn-config',
        service: 'network',
        name: 'Disable VPN',
        endpoint: 'POST /api/vpn/config/disable',
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        req: { method: 'POST', path: '/api/vpn/config/disable', body: {} },
        expect: REACHABLE,
      }),
    ],
  },

  // ───────────────────────── VPN Peers ───────────────────────────
  {
    id: 'network.vpn-peers',
    service: 'network',
    name: 'Network · VPN Peers',
    description: 'Full create→read→update→config→enable→delete on a throwaway peer.',
    tests: [
      def({
        id: 'network.vpn-peers.list',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'List VPN peers',
        endpoint: 'GET /api/vpn/peers',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/vpn/peers' },
        assert: assertList,
      }),
      def({
        id: 'network.vpn-peers.create',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Create throwaway peer',
        endpoint: 'POST /api/vpn/peers',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        req: () => ({
          method: 'POST',
          path: '/api/vpn/peers',
          body: { name: `verify-peer-${tag()}` },
        }),
        expect: [200, 201],
        capture: capId('id', 'peer_id')('peerId'),
      }),
      def({
        id: 'network.vpn-peers.get',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Get throwaway peer',
        endpoint: 'GET /api/vpn/peers/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        requires: ['peerId'],
        req: () => ({ method: 'GET', path: '/api/vpn/peers/{{peerId}}' }),
      }),
      def({
        id: 'network.vpn-peers.update',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Update throwaway peer',
        endpoint: 'PATCH /api/vpn/peers/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['peerId'],
        req: () => ({
          method: 'PATCH',
          path: '/api/vpn/peers/{{peerId}}',
          body: { name: 'verify-peer-upd' },
        }),
        expect: [200],
      }),
      def({
        id: 'network.vpn-peers.config',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Get peer config file',
        endpoint: 'GET /api/vpn/peers/:id/config',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        requires: ['peerId'],
        req: () => ({ method: 'GET', path: '/api/vpn/peers/{{peerId}}/config' }),
        expect: [200, 404],
      }),
      def({
        id: 'network.vpn-peers.enable',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Enable peer',
        endpoint: 'POST /api/vpn/peers/:id/enable',
        // Activates the peer on the live WireGuard interface.
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['peerId'],
        req: () => ({ method: 'POST', path: '/api/vpn/peers/{{peerId}}/enable' }),
        expect: REACHABLE,
      }),
      def({
        id: 'network.vpn-peers.disable',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Disable peer',
        endpoint: 'POST /api/vpn/peers/:id/disable',
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['peerId'],
        req: () => ({ method: 'POST', path: '/api/vpn/peers/{{peerId}}/disable' }),
        expect: REACHABLE,
      }),
      def({
        id: 'network.vpn-peers.delete',
        suite: 'network.vpn-peers',
        service: 'network',
        name: 'Delete throwaway peer (cleanup)',
        endpoint: 'DELETE /api/vpn/peers/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['peerId'],
        req: () => ({ method: 'DELETE', path: '/api/vpn/peers/{{peerId}}' }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.peerId;
        },
      }),
    ],
  },

  // ───────────────────────── Mesh ────────────────────────────────
  {
    id: 'network.mesh',
    service: 'network',
    name: 'Network · Mesh',
    description: 'Mesh sites lifecycle plus topology/route inspection.',
    tests: [
      def({
        id: 'network.mesh.sites-list',
        suite: 'network.mesh',
        service: 'network',
        name: 'List mesh sites',
        endpoint: 'GET /api/mesh/sites',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/mesh/sites' },
        assert: assertList,
      }),
      def({
        id: 'network.mesh.site-create',
        suite: 'network.mesh',
        service: 'network',
        name: 'Create throwaway mesh site',
        endpoint: 'POST /api/mesh/sites',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        req: () => ({
          method: 'POST',
          path: '/api/mesh/sites',
          body: { name: `verify-site-${tag()}` },
        }),
        expect: [200, 201],
        capture: capId('id', 'site_id')('meshSiteId'),
      }),
      def({
        id: 'network.mesh.site-get',
        suite: 'network.mesh',
        service: 'network',
        name: 'Get throwaway mesh site',
        endpoint: 'GET /api/mesh/sites/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        requires: ['meshSiteId'],
        req: () => ({ method: 'GET', path: '/api/mesh/sites/{{meshSiteId}}' }),
      }),
      def({
        id: 'network.mesh.site-update',
        suite: 'network.mesh',
        service: 'network',
        name: 'Update throwaway mesh site',
        endpoint: 'PATCH /api/mesh/sites/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['meshSiteId'],
        req: () => ({
          method: 'PATCH',
          path: '/api/mesh/sites/{{meshSiteId}}',
          body: { name: 'verify-site-upd' },
        }),
        expect: [200],
      }),
      def({
        id: 'network.mesh.site-ping',
        suite: 'network.mesh',
        service: 'network',
        name: 'Ping mesh site',
        endpoint: 'POST /api/mesh/sites/:id/ping',
        // Issues a live network probe across the mesh fabric.
        safety: 'system',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['meshSiteId'],
        req: () => ({ method: 'POST', path: '/api/mesh/sites/{{meshSiteId}}/ping' }),
        expect: FABRIC_REACHABLE,
      }),
      def({
        id: 'network.mesh.site-delete',
        suite: 'network.mesh',
        service: 'network',
        name: 'Delete throwaway mesh site (cleanup)',
        endpoint: 'DELETE /api/mesh/sites/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['network:manage'],
        requires: ['meshSiteId'],
        req: () => ({ method: 'DELETE', path: '/api/mesh/sites/{{meshSiteId}}' }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.meshSiteId;
        },
      }),
      def({
        id: 'network.mesh.topology',
        suite: 'network.mesh',
        service: 'network',
        name: 'Get mesh topology',
        endpoint: 'GET /api/mesh/topology',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/mesh/topology' },
      }),
      def({
        id: 'network.mesh.routes',
        suite: 'network.mesh',
        service: 'network',
        name: 'Get mesh routes',
        endpoint: 'GET /api/mesh/routes',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/mesh/routes' },
      }),
    ],
  },

  // ───────────────────────── Stats ───────────────────────────────
  {
    id: 'network.stats',
    service: 'network',
    name: 'Network · Stats',
    description:
      'Aggregate network stats: per-server public/private IPs and traffic, the ' +
      'active proxy, proxy counts, and the current system base URL.',
    tests: [
      def({
        id: 'network.stats.get',
        suite: 'network.stats',
        service: 'network',
        name: 'Get network stats',
        endpoint: 'GET /api/network/stats',
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/network/stats' },
        // Portal reaches this with a user session; an app token with network:read
        // works too, but tolerate 403 if the service gates it to user JWTs only.
        expect: [200, 403],
      }),
      def({
        id: 'network.stats.base-url-propagation',
        suite: 'network.stats',
        service: 'network',
        name: 'Base-URL propagation status (Option B)',
        endpoint: 'GET /api/network/base-url-propagation',
        // Per-service push status of the last system-base-URL fan-out
        // (atlas-system §7.4): identity/email/app-store/portal receiver results.
        safety: 'read',
        auth: 'app',
        scopes: ['network:read'],
        req: { method: 'GET', path: '/api/network/base-url-propagation' },
        expect: [200, 403],
      }),
    ],
  },
];
