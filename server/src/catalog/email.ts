import type { Suite, VarBag } from '../engine/types.js';
import { def } from './util.js';
import {
  unwrap,
  firstOf,
  REACHABLE,
  assertList,
  tag,
} from '../engine/helpers.js';

// Fixed throwaway resources. Mailbox + domain use stable names (no tag suffix)
// so re-runs hit the same row instead of accumulating; their create steps
// accept 409. Per-message and per-rule names use tag() for uniqueness.
const PROBE_ADDRESS = 'varify-probe@varify.test';
const PROBE_DOMAIN = 'varify-probe.test';

/**
 * Capture an id-like value into a run variable, tolerating both the Atlas
 * { data, meta } envelope and the flat bodies the Email service returns for
 * send/mailbox-create (where message_id / mailbox_id sit at the top level).
 */
const capId =
  (...keys: string[]) =>
  (varName: string) =>
  (body: unknown, vars: VarBag) => {
    const id =
      firstOf(unwrap(body), ...keys) ?? firstOf(body as any, ...keys);
    if (id !== undefined) vars[varName] = id;
  };

export const emailSuites: Suite[] = [
  // ───────────────────────── Health ──────────────────────────────
  {
    id: 'email.health',
    service: 'email',
    name: 'Email · Health',
    description: 'Unauthenticated liveness, readiness and metrics probes.',
    tests: [
      def({
        id: 'email.health.live',
        suite: 'email.health',
        service: 'email',
        name: 'Liveness probe',
        endpoint: 'GET /health/live',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health/live' },
      }),
      def({
        id: 'email.health.ready',
        suite: 'email.health',
        service: 'email',
        name: 'Readiness probe',
        endpoint: 'GET /health/ready',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/health/ready' },
      }),
      def({
        id: 'email.health.metrics',
        suite: 'email.health',
        service: 'email',
        name: 'Prometheus metrics',
        endpoint: 'GET /metrics',
        safety: 'read',
        auth: 'none',
        req: { method: 'GET', path: '/metrics' },
      }),
    ],
  },

  // ───────────────────────── Mailboxes ───────────────────────────
  {
    id: 'email.mailboxes',
    service: 'email',
    name: 'Email · Mailboxes',
    description: 'Create/resolve a fixed probe mailbox and add a throwaway alias.',
    tests: [
      def({
        id: 'email.mailboxes.create',
        suite: 'email.mailboxes',
        service: 'email',
        name: 'Create probe mailbox',
        endpoint: 'POST /api/v1/mailboxes',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:mailboxes:create'],
        // Fixed address + 409 acceptance keeps re-runs idempotent.
        req: {
          method: 'POST',
          path: '/api/v1/mailboxes',
          body: {
            address: PROBE_ADDRESS,
            type: 'APP',
            display_name: 'Varify Probe',
          },
        },
        expect: [200, 201, 409],
      }),
      def({
        id: 'email.mailboxes.resolve',
        suite: 'email.mailboxes',
        service: 'email',
        name: 'Resolve probe mailbox',
        endpoint: 'GET /api/v1/mailboxes:resolve',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        req: {
          method: 'GET',
          path: '/api/v1/mailboxes:resolve',
          query: { address: PROBE_ADDRESS },
        },
        expect: [200, 404],
        capture: capId('mailbox_id', 'id', 'mailboxId')('mboxId'),
      }),
      def({
        id: 'email.mailboxes.list',
        suite: 'email.mailboxes',
        service: 'email',
        name: 'List mailboxes',
        endpoint: 'GET /api/v1/mailboxes',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        req: { method: 'GET', path: '/api/v1/mailboxes' },
      }),
      def({
        id: 'email.mailboxes.alias-create',
        suite: 'email.mailboxes',
        service: 'email',
        name: 'Add throwaway alias',
        endpoint: 'POST /api/v1/mailboxes/:id/aliases',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:mailboxes:create'],
        requires: ['mboxId'],
        req: () => ({
          method: 'POST',
          path: '/api/v1/mailboxes/{{mboxId}}/aliases',
          body: { address: `varify-alias-${tag()}@varify.test` },
        }),
        expect: [200, 201, 409],
      }),
    ],
  },

  // ───────────────────────── Messages ────────────────────────────
  {
    id: 'email.messages',
    service: 'email',
    name: 'Email · Messages',
    description: 'Send a probe message then read/label/trash/restore it.',
    tests: [
      def({
        id: 'email.messages.send',
        suite: 'email.messages',
        service: 'email',
        name: 'Send probe message',
        endpoint: 'POST /api/v1/messages:send',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:send'],
        // The runner auto-attaches an Idempotency-Key on messages:send paths.
        req: {
          method: 'POST',
          path: '/api/v1/messages:send',
          body: {
            from: { email: PROBE_ADDRESS, name: 'Varify' },
            to: [{ email: 'varify-dest@varify.test' }],
            subject: 'Varify probe',
            html_body: '<p>hi</p>',
            text_body: 'hi',
          },
        },
        expect: [202, 200],
        capture: (body, vars) => {
          capId('message_id', 'id', 'messageId')('msgId')(body, vars);
          capId('thread_id', 'threadId')('threadId')(body, vars);
        },
      }),
      def({
        id: 'email.messages.mailbox-list',
        suite: 'email.messages',
        service: 'email',
        name: 'List mailbox messages',
        endpoint: 'GET /api/v1/mailboxes/:id/messages',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['mboxId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/mailboxes/{{mboxId}}/messages',
        }),
      }),
      def({
        id: 'email.messages.get',
        suite: 'email.messages',
        service: 'email',
        name: 'Get probe message',
        endpoint: 'GET /api/v1/messages/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({ method: 'GET', path: '/api/v1/messages/{{msgId}}' }),
      }),
      def({
        id: 'email.messages.raw',
        suite: 'email.messages',
        service: 'email',
        name: 'Get raw RFC822 message',
        endpoint: 'GET /api/v1/messages/:id/raw',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({ method: 'GET', path: '/api/v1/messages/{{msgId}}/raw' }),
        expect: [200, 404],
      }),
      def({
        id: 'email.messages.patch',
        suite: 'email.messages',
        service: 'email',
        name: 'Label probe message',
        endpoint: 'PATCH /api/v1/messages/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({
          method: 'PATCH',
          path: '/api/v1/messages/{{msgId}}',
          body: { labels: ['varify'] },
        }),
        expect: [200, 204],
      }),
      def({
        id: 'email.messages.trash',
        suite: 'email.messages',
        service: 'email',
        name: 'Trash probe message',
        endpoint: 'POST /api/v1/messages/:id:trash',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({ method: 'POST', path: '/api/v1/messages/{{msgId}}:trash' }),
        expect: [200, 204],
      }),
      def({
        id: 'email.messages.restore',
        suite: 'email.messages',
        service: 'email',
        name: 'Restore probe message',
        endpoint: 'POST /api/v1/messages/:id:restore',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({
          method: 'POST',
          path: '/api/v1/messages/{{msgId}}:restore',
        }),
        expect: [200, 204],
      }),
    ],
  },

  // ───────────────────────── Attachments ─────────────────────────
  {
    id: 'email.attachments',
    service: 'email',
    name: 'Email · Attachments',
    description: 'List attachments/inline parts; downloads probe reachability.',
    tests: [
      def({
        id: 'email.attachments.list',
        suite: 'email.attachments',
        service: 'email',
        name: 'List attachments',
        endpoint: 'GET /api/v1/messages/:id/attachments',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/messages/{{msgId}}/attachments',
        }),
        // The probe message has no attachments; list may be empty.
        expect: [200, 404],
      }),
      def({
        id: 'email.attachments.download',
        suite: 'email.attachments',
        service: 'email',
        name: 'Download attachment (reachability)',
        endpoint: 'GET /api/v1/messages/:id/attachments/:attId/download',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        // No real attachment id; a nonexistent one proves route + auth wiring.
        req: () => ({
          method: 'GET',
          path: '/api/v1/messages/{{msgId}}/attachments/varify-none/download',
        }),
        expect: REACHABLE,
      }),
      def({
        id: 'email.attachments.inline-list',
        suite: 'email.attachments',
        service: 'email',
        name: 'List inline parts',
        endpoint: 'GET /api/v1/messages/:id/inline',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({ method: 'GET', path: '/api/v1/messages/{{msgId}}/inline' }),
        expect: [200, 404],
      }),
      def({
        id: 'email.attachments.inline-download',
        suite: 'email.attachments',
        service: 'email',
        name: 'Download inline part (reachability)',
        endpoint: 'GET /api/v1/messages/:id/inline/:cid/download',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/messages/{{msgId}}/inline/varify-none/download',
        }),
        expect: REACHABLE,
      }),
    ],
  },

  // ───────────────────────── Rules ───────────────────────────────
  {
    id: 'email.rules',
    service: 'email',
    name: 'Email · Rules',
    description: 'Create→read→update→simulate→delete a throwaway filter rule.',
    tests: [
      def({
        id: 'email.rules.create',
        suite: 'email.rules',
        service: 'email',
        name: 'Create throwaway rule',
        endpoint: 'POST /api/v1/rules',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:rules:manage'],
        requires: ['mboxId'],
        req: (v) => ({
          method: 'POST',
          path: '/api/v1/rules',
          body: {
            mailbox_id: v.mboxId,
            name: `varify-rule-${tag()}`,
            priority: 1,
            predicate: { field: 'subject', op: 'contains', value: 'varify' },
            actions: [{ type: 'ADD_LABEL', value: 'varify' }],
          },
        }),
        expect: [200, 201],
        capture: capId('id', 'rule_id', 'ruleId')('ruleId'),
      }),
      def({
        id: 'email.rules.list',
        suite: 'email.rules',
        service: 'email',
        name: 'List rules',
        endpoint: 'GET /api/v1/rules',
        safety: 'read',
        auth: 'app',
        scopes: ['email:rules:manage'],
        req: { method: 'GET', path: '/api/v1/rules' },
      }),
      def({
        id: 'email.rules.get',
        suite: 'email.rules',
        service: 'email',
        name: 'Get throwaway rule',
        endpoint: 'GET /api/v1/rules/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['email:rules:manage'],
        requires: ['ruleId'],
        req: () => ({ method: 'GET', path: '/api/v1/rules/{{ruleId}}' }),
      }),
      def({
        id: 'email.rules.update',
        suite: 'email.rules',
        service: 'email',
        name: 'Update throwaway rule',
        endpoint: 'PATCH /api/v1/rules/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:rules:manage'],
        requires: ['ruleId'],
        req: () => ({
          method: 'PATCH',
          path: '/api/v1/rules/{{ruleId}}',
          body: { priority: 2 },
        }),
      }),
      def({
        id: 'email.rules.simulate',
        suite: 'email.rules',
        service: 'email',
        name: 'Simulate rule match',
        endpoint: 'POST /api/v1/rules:simulate',
        safety: 'read',
        auth: 'app',
        scopes: ['email:rules:manage'],
        requires: ['mboxId'],
        req: (v) => ({
          method: 'POST',
          path: '/api/v1/rules:simulate',
          body: {
            mailbox_id: v.mboxId,
            message: { subject: 'varify test' },
          },
        }),
        expect: [200, 400],
      }),
      def({
        id: 'email.rules.delete',
        suite: 'email.rules',
        service: 'email',
        name: 'Delete throwaway rule (cleanup)',
        endpoint: 'DELETE /api/v1/rules/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['email:rules:manage'],
        requires: ['ruleId'],
        req: () => ({ method: 'DELETE', path: '/api/v1/rules/{{ruleId}}' }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.ruleId;
        },
      }),
    ],
  },

  // ───────────────────────── Outbox & Delivery ───────────────────
  {
    id: 'email.outbox',
    service: 'email',
    name: 'Email · Outbox & Delivery',
    description: 'Consume the outbox event stream and read delivery status.',
    tests: [
      def({
        id: 'email.outbox.events',
        suite: 'email.outbox',
        service: 'email',
        name: 'Consume outbox events',
        endpoint: 'GET /api/v1/outbox/events',
        safety: 'read',
        auth: 'app',
        scopes: ['email:outbox:consume'],
        req: {
          method: 'GET',
          path: '/api/v1/outbox/events',
          query: { after_id: '0' },
        },
      }),
      def({
        id: 'email.outbox.delivery',
        suite: 'email.outbox',
        service: 'email',
        name: 'Get message delivery status',
        endpoint: 'GET /api/v1/messages/:id/delivery',
        safety: 'read',
        auth: 'app',
        scopes: ['email:read'],
        requires: ['msgId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/messages/{{msgId}}/delivery',
        }),
        expect: [200, 404],
      }),
    ],
  },

  // ───────────────────────── Admin · Domains ─────────────────────
  {
    id: 'email.domains',
    service: 'email',
    name: 'Email · Admin Domains',
    description:
      'Create/inspect a fixed probe domain; set-primary is system-level (off by default).',
    tests: [
      def({
        id: 'email.domains.create',
        suite: 'email.domains',
        service: 'email',
        name: 'Create probe domain',
        endpoint: 'POST /api/v1/admin/domains',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['admin'],
        // Fixed name + 409 acceptance keeps re-runs idempotent. 'name' included
        // as a fallback key alongside 'domain'.
        req: {
          method: 'POST',
          path: '/api/v1/admin/domains',
          body: { domain: PROBE_DOMAIN, name: PROBE_DOMAIN },
        },
        expect: [200, 201, 409],
      }),
      def({
        id: 'email.domains.list',
        suite: 'email.domains',
        service: 'email',
        name: 'List domains',
        endpoint: 'GET /api/v1/admin/domains',
        safety: 'read',
        auth: 'app',
        scopes: ['admin'],
        req: { method: 'GET', path: '/api/v1/admin/domains' },
        assert: assertList,
        capture: (body, vars) => {
          const data = unwrap(body);
          const list: any[] = Array.isArray(data) ? data : [];
          const match = list.find(
            (d) => d?.name === PROBE_DOMAIN || d?.domain === PROBE_DOMAIN,
          );
          if (match) {
            const id = firstOf(match, 'id', 'domain_id', 'domainId');
            if (id !== undefined) vars.domainId = id;
          }
        },
      }),
      def({
        id: 'email.domains.get',
        suite: 'email.domains',
        service: 'email',
        name: 'Get probe domain',
        endpoint: 'GET /api/v1/admin/domains/:id',
        safety: 'read',
        auth: 'app',
        scopes: ['admin'],
        requires: ['domainId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/admin/domains/{{domainId}}',
        }),
      }),
      def({
        id: 'email.domains.dns',
        suite: 'email.domains',
        service: 'email',
        name: 'Get domain DNS records',
        endpoint: 'GET /api/v1/admin/domains/:id/dns',
        safety: 'read',
        auth: 'app',
        scopes: ['admin'],
        requires: ['domainId'],
        req: () => ({
          method: 'GET',
          path: '/api/v1/admin/domains/{{domainId}}/dns',
        }),
      }),
      def({
        id: 'email.domains.verify',
        suite: 'email.domains',
        service: 'email',
        name: 'Trigger DNS verification (reachability)',
        endpoint: 'POST /api/v1/admin/domains/:id:verify',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['admin'],
        requires: ['domainId'],
        // DNS verification depends on real external records; treat any wired
        // 2xx/4xx as reachable.
        req: () => ({
          method: 'POST',
          path: '/api/v1/admin/domains/{{domainId}}:verify',
        }),
        expect: REACHABLE,
      }),
      def({
        id: 'email.domains.set-primary',
        suite: 'email.domains',
        service: 'email',
        name: 'Set primary domain',
        endpoint: 'POST /api/v1/admin/domains/:id:set-primary',
        // Changes the org's primary domain — global state, off by default.
        safety: 'system',
        auth: 'app',
        scopes: ['admin'],
        requires: ['domainId'],
        req: () => ({
          method: 'POST',
          path: '/api/v1/admin/domains/{{domainId}}:set-primary',
        }),
        expect: [200, 204, 400, 409],
      }),
      def({
        id: 'email.domains.delete',
        suite: 'email.domains',
        service: 'email',
        name: 'Delete probe domain (cleanup)',
        endpoint: 'DELETE /api/v1/admin/domains/:id',
        safety: 'write-isolated',
        auth: 'app',
        scopes: ['admin'],
        requires: ['domainId'],
        req: () => ({
          method: 'DELETE',
          path: '/api/v1/admin/domains/{{domainId}}',
        }),
        expect: [200, 204],
        capture: (_b, vars) => {
          delete vars.domainId;
        },
      }),
    ],
  },

  // ───────────────────────── Admin · Config ──────────────────────
  {
    id: 'email.config',
    service: 'email',
    name: 'Email · Admin Config',
    description: 'Read retention config; the patch is system-level (off by default).',
    tests: [
      def({
        id: 'email.config.retention-get',
        suite: 'email.config',
        service: 'email',
        name: 'Get retention config',
        endpoint: 'GET /api/v1/admin/config/retention',
        safety: 'read',
        auth: 'app',
        scopes: ['admin'],
        req: { method: 'GET', path: '/api/v1/admin/config/retention' },
      }),
      def({
        id: 'email.config.retention-patch',
        suite: 'email.config',
        service: 'email',
        name: 'Update retention config (no-op)',
        endpoint: 'PATCH /api/v1/admin/config/retention',
        // Retention is org-wide global state; opt-in only.
        safety: 'system',
        auth: 'app',
        scopes: ['admin'],
        req: { method: 'PATCH', path: '/api/v1/admin/config/retention', body: {} },
        expect: [200, 204, 400],
      }),
    ],
  },
];
