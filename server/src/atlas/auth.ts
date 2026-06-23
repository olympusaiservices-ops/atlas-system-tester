import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { send, pickCookie } from './client.js';
import type { AuthMode } from '../engine/types.js';

/**
 * The full scope set the tester requests for its app/M2M token. The documented
 * `admin` scope satisfies any per-service scope check; we also request the
 * specific scopes so the token works even if `admin` is not granted.
 */
export const REQUESTED_SCOPES = [
  'admin',
  'email:send',
  'email:read',
  'email:mailboxes:create',
  'email:rules:manage',
  'email:outbox:consume',
  'users:list',
  'system:read',
  'appstore:read',
  'appstore:install',
  'appstore:upgrade',
  'appstore:uninstall',
  'appstore:purchase:initiate',
  'appstore:telemetry:configure',
  'appstore:audit:read',
  'appstore:thirdparty:manage',
  'network:manage',
  'portal:admin',
];

export interface ConnectInput {
  adminEmail: string;
  adminPassword: string;
  totp?: string;
  /** 'auto' self-registers an app; 'manual' uses supplied client creds. */
  appAuth: 'auto' | 'manual';
  clientId?: string;
  clientSecret?: string;
}

export interface ConnectionState {
  connected: boolean;
  adminEmail?: string;
  userId?: string;
  appId?: string;
  clientId?: string;
  appAuth: 'auto' | 'manual';
  scopesGranted?: string[];
  /** Per-mode availability for the UI. */
  haveUserToken: boolean;
  haveAppToken: boolean;
  notes: string[];
}

interface CachedAppCreds {
  appId: string;
  clientId: string;
  clientSecret: string;
}

const CREDS_FILE = () => path.join(config.dataDir, 'app-creds.json');

function unwrap(body: unknown): any {
  // Identity wraps payloads in { data, meta }. Tolerate both shapes.
  if (body && typeof body === 'object' && 'data' in (body as any)) {
    return (body as any).data;
  }
  return body;
}

export class AuthManager {
  private userToken?: string;
  private appToken?: string;
  private refreshCookie?: string;
  private state: ConnectionState = {
    connected: false,
    appAuth: 'auto',
    haveUserToken: false,
    haveAppToken: false,
    notes: [],
  };

  getState(): ConnectionState {
    return this.state;
  }

  /** Token/cookie for a given auth mode; undefined if unavailable. */
  tokenFor(mode: AuthMode): { token?: string; cookie?: string } {
    switch (mode) {
      case 'user':
        return { token: this.userToken };
      case 'app':
        return { token: this.appToken };
      case 'refresh':
        return { cookie: this.refreshCookie };
      case 'none':
      default:
        return {};
    }
  }

  get appId(): string | undefined {
    return this.state.appId;
  }
  get userId(): string | undefined {
    return this.state.userId;
  }
  get adminEmail(): string | undefined {
    return this.state.adminEmail;
  }

  async connect(input: ConnectInput): Promise<ConnectionState> {
    const notes: string[] = [];
    this.reset();

    // 1) Admin login → user JWT + refresh cookie.
    const loginBody: Record<string, unknown> = {
      email: input.adminEmail,
      password: input.adminPassword,
    };
    if (input.totp) {
      // The exact key is undocumented; send the common variants.
      loginBody.totp = input.totp;
      loginBody.totpCode = input.totp;
      loginBody.code = input.totp;
    }
    const login = await send({
      service: 'identity',
      method: 'POST',
      path: '/api/auth/login',
      body: loginBody,
    });
    if (!login.ok) {
      throw new Error(
        `Admin login failed (HTTP ${login.status}): ${login.error || login.rawText || 'unknown error'}`,
      );
    }
    const loginData = unwrap(login.body);
    this.userToken = loginData?.accessToken || loginData?.access_token;
    if (!this.userToken) {
      throw new Error('Login succeeded but no accessToken was returned.');
    }
    const cookie =
      pickCookie(login.setCookies, 'accm_refresh') ||
      pickCookie(login.setCookies, 'atlas_portal_session') ||
      (login.setCookies[0] ? login.setCookies[0].split(';')[0] : null);
    if (cookie) this.refreshCookie = cookie;

    // 2) Resolve who we are (id is needed for some self-service tests).
    const me = await send({
      service: 'identity',
      method: 'GET',
      path: '/api/me',
      token: this.userToken,
    });
    const meData = unwrap(me.body);
    const userId =
      meData?.atlasUserId || meData?.id || meData?.sub || undefined;

    this.state = {
      connected: true,
      adminEmail: input.adminEmail,
      userId,
      appAuth: input.appAuth,
      haveUserToken: true,
      haveAppToken: false,
      notes,
    };

    // 3) Obtain an app/M2M token.
    try {
      const creds =
        input.appAuth === 'manual'
          ? await this.useManualCreds(input)
          : await this.provisionApp();
      this.state.appId = creds.appId;
      this.state.clientId = creds.clientId;
      const mint = await this.mintAppToken(creds);
      this.appToken = mint.token;
      this.state.haveAppToken = !!mint.token;
      this.state.scopesGranted = mint.scopes;
      if (!mint.token) {
        notes.push(
          'App token could not be minted; app-scoped tests (email/appstore/network) will be skipped.',
        );
      }
    } catch (err) {
      notes.push(
        `App credential setup failed: ${(err as Error).message}. App-scoped tests will be skipped.`,
      );
    }

    return this.state;
  }

  private reset() {
    this.userToken = undefined;
    this.appToken = undefined;
    this.refreshCookie = undefined;
  }

  private async useManualCreds(input: ConnectInput): Promise<CachedAppCreds> {
    if (!input.clientId || !input.clientSecret) {
      throw new Error('Manual auth selected but clientId/clientSecret missing.');
    }
    // app_id is optional for token mint but required for /api/apps/{appId}/*
    // tests. Try to resolve it from the admin app list.
    let appId = '';
    const apps = await send({
      service: 'identity',
      method: 'GET',
      path: '/api/admin/apps',
      token: this.userToken,
    });
    const list = unwrap(apps.body);
    if (Array.isArray(list)) {
      const match = list.find(
        (a: any) =>
          a?.client_id === input.clientId ||
          a?.clients?.some?.((c: any) => c.client_id === input.clientId),
      );
      appId = match?.app_id || match?.id || '';
    }
    return {
      appId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    };
  }

  /** Register (or reuse) the tester's own app and return usable client creds. */
  private async provisionApp(): Promise<CachedAppCreds> {
    const cached = await this.readCachedCreds();
    if (cached) {
      this.state.notes.push('Reusing cached app registration.');
      return cached;
    }

    const reg = await send({
      service: 'identity',
      method: 'POST',
      path: '/api/admin/apps',
      token: this.userToken,
      body: {
        name: config.appKey,
        description: 'Atlas Verify — automated core API tester',
        login_modes: [],
      },
    });

    if (reg.ok) {
      const data = unwrap(reg.body);
      const appId = data?.app?.app_id || data?.app?.id || data?.app_id;
      const clientId = data?.client?.client_id || data?.client_id;
      const clientSecret =
        data?.client?.client_secret || data?.client_secret;
      if (appId && clientId && clientSecret) {
        const creds = { appId, clientId, clientSecret };
        await this.writeCachedCreds(creds);
        this.state.notes.push('Registered new app "' + config.appKey + '".');
        return creds;
      }
      throw new Error('App registration response was missing client secret.');
    }

    // Already registered (or registration not permitted): find it and rotate
    // the client secret so we have usable credentials.
    const apps = await send({
      service: 'identity',
      method: 'GET',
      path: '/api/admin/apps',
      token: this.userToken,
    });
    const list = unwrap(apps.body);
    const mine = Array.isArray(list)
      ? list.find((a: any) => a?.name === config.appKey)
      : undefined;
    if (!mine) {
      throw new Error(
        `Could not register or locate the "${config.appKey}" app (HTTP ${reg.status}).`,
      );
    }
    const appId = mine.app_id || mine.id;
    const rotate = await send({
      service: 'identity',
      method: 'POST',
      path: `/api/admin/apps/${appId}/rotate-client-secret`,
      token: this.userToken,
    });
    const rdata = unwrap(rotate.body);
    const clientId =
      rdata?.client_id || mine?.client_id || mine?.clients?.[0]?.client_id;
    const clientSecret = rdata?.client_secret;
    if (!clientId || !clientSecret) {
      throw new Error('Found existing app but could not obtain a client secret.');
    }
    const creds = { appId, clientId, clientSecret };
    await this.writeCachedCreds(creds);
    this.state.notes.push('Reused existing app with a rotated client secret.');
    return creds;
  }

  private async mintAppToken(
    creds: CachedAppCreds,
  ): Promise<{ token?: string; scopes?: string[] }> {
    const res = await send({
      service: 'identity',
      method: 'POST',
      path: '/api/apps/auth/token',
      body: {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        scopes: REQUESTED_SCOPES,
      },
    });
    if (!res.ok) return {};
    const data = unwrap(res.body);
    return {
      token: data?.accessToken || data?.access_token,
      scopes: data?.scopes || REQUESTED_SCOPES,
    };
  }

  private async readCachedCreds(): Promise<CachedAppCreds | null> {
    try {
      const raw = await fs.readFile(CREDS_FILE(), 'utf8');
      const parsed = JSON.parse(raw) as CachedAppCreds;
      if (parsed.clientId && parsed.clientSecret) return parsed;
    } catch {
      /* no cache yet */
    }
    return null;
  }

  private async writeCachedCreds(creds: CachedAppCreds): Promise<void> {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(CREDS_FILE(), JSON.stringify(creds, null, 2), {
        mode: 0o600,
      });
    } catch {
      this.state.notes.push('Warning: could not persist app credentials cache.');
    }
  }
}

export const auth = new AuthManager();
