import type { VarBag } from './types.js';

/** Replace {{var}} placeholders in a path/string with values from the bag. */
export function interpolate(input: string, vars: VarBag): string {
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });
}

/** Returns true if the string still has unresolved placeholders. */
export function hasUnresolved(input: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(input);
}

/** Unwrap the Atlas { data, meta } envelope if present. */
export function unwrap(body: unknown): any {
  if (body && typeof body === 'object' && 'data' in (body as any)) {
    return (body as any).data;
  }
  return body;
}

/** First defined value among several candidate keys on an object. */
export function firstOf(obj: any, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * "Reachable" status set: the endpoint is wired and auth passed, even if the
 * specific resource/state means a 4xx (not found, conflict, validation). Used
 * for endpoints we cannot fully exercise without real-world state (DNS
 * verification, purchases, etc.). A 401/403/5xx still counts as a failure.
 */
export const REACHABLE = [200, 201, 202, 204, 400, 404, 409, 422];

/** A unique-ish suffix for throwaway resource names within a run. */
export function tag(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Assert the response body carries the Atlas { data, meta } envelope. */
export function assertEnvelope(body: unknown): string[] {
  if (!body || typeof body !== 'object') return ['response body is not an object'];
  if (!('data' in (body as any))) return ['response is missing the "data" envelope key'];
  return [];
}

/** Assert the unwrapped payload is an array (list endpoints). */
export function assertList(body: unknown): string[] {
  const data = unwrap(body);
  if (!Array.isArray(data)) return ['expected a list payload (array under "data")'];
  return [];
}
