/**
 * Shared primitives used by every route handler + dispatch (Phase 12 T-075).
 *
 * Kept small — types, allow-methods constant, tiny JSON-response helper,
 * body redactor. Anything larger lives in its own module.
 *
 * Traces: FR-42 AC-42.1, AC-42.2.
 */
import type { ResponseShape } from '../security/headers';

export interface WaitUntilLike {
  waitUntil(promise: Promise<unknown>): void;
}

export type DispatchResult = { response: Response; shape: ResponseShape };

export const API_ALLOW_METHODS = 'GET, HEAD, OPTIONS';

/** Small helper that builds a JSON Response with the canonical headers
 *  every worker-emitted body should carry. Callers layer on CORS via
 *  `extraHeaders`. */
export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

/** Redact API-key-shaped substrings from a response body. Defensive —
 *  upstream never echoes our key in error bodies today, but layered
 *  defense keeps secrets from ever leaving the Worker in any shape. */
export function sanitizeBody(body: string, redactList: string[]): string {
  let out = body;
  for (const v of redactList) {
    if (v) out = out.split(v).join('[REDACTED]');
  }
  return out;
}
