import { randomUUID } from 'node:crypto';
import { endpointFor, type AtlasEndpoints } from '../config.js';

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown; // parsed JSON when possible, else raw text
  rawText: string;
  durationMs: number;
  /** Set-Cookie values returned by the server (used for the refresh cookie). */
  setCookies: string[];
  error?: string; // transport-level error (DNS, timeout, connection refused)
}

export interface SendOptions {
  service: keyof AtlasEndpoints;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Bearer token to send, if any. */
  token?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Cookie header value (e.g. the refresh cookie) to send. */
  cookie?: string;
  /** Add an Idempotency-Key header (required by Email send). */
  idempotent?: boolean;
  timeoutMs?: number;
}

const SENSITIVE_HEADER = /authorization|cookie|secret/i;

/** Redact secrets before a header map is stored in a result/log. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER.test(k) ? '«redacted»' : v;
  }
  return out;
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function send(opts: SendOptions): Promise<HttpResult> {
  const base = endpointFor(opts.service);
  const url = buildUrl(base, opts.path, opts.query);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers || {}),
  };

  // Identity (ACCM) documents a versioning header. It is harmless elsewhere but
  // we only attach it to Identity requests to mirror the documented contract.
  if (opts.service === 'identity') {
    headers['Accept'] = 'application/vnd.atlasid.v1+json';
  }
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  if (opts.idempotent && !headers['Idempotency-Key']) {
    headers['Idempotency-Key'] = randomUUID();
  }

  let payload: string | undefined;
  if (opts.body !== undefined && opts.method !== 'GET') {
    payload = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 20_000,
  );

  try {
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body: payload,
      signal: controller.signal,
      redirect: 'manual',
    });
    const rawText = await res.text();
    const durationMs = Math.round(performance.now() - started);

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const setCookies = readSetCookies(res);

    let parsed: unknown = rawText;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') || looksJson(rawText)) {
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = rawText;
      }
    }

    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: resHeaders,
      body: parsed,
      rawText,
      durationMs,
      setCookies,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'request timed out'
          : err.message
        : String(err);
    return {
      status: 0,
      ok: false,
      headers: {},
      body: null,
      rawText: '',
      durationMs,
      setCookies: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function readSetCookies(res: Response): string[] {
  // Node fetch exposes getSetCookie() on Headers (undici).
  const anyHeaders = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/** Extract a "name=value" cookie pair from a Set-Cookie list, by name prefix. */
export function pickCookie(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const pair = c.split(';')[0];
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}
