/**
 * Tiny typed fetcher for the admin SPA. Resolves the API base from a
 * `?env=<name>` URL param so the same dev build can target dev/uat/stg/prod
 * via the Vite proxy when running locally.
 *
 * Traces to FR-52 AC-52.3.
 */

export type Env = 'local' | 'dev' | 'uat' | 'stg' | 'prod';

export function resolveApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const env = (params.get('env') ?? 'local') as Env;
  switch (env) {
    case 'dev':
      return '/env-dev';
    case 'uat':
      return '/env-uat';
    case 'stg':
      return '/env-stg';
    case 'prod':
      return '/env-prod';
    case 'local':
    default:
      return '';
  }
}

export interface FetchError {
  status: number;
  error: string;
  detail?: string;
  traceId?: string;
}

async function parseError(res: Response): Promise<FetchError> {
  let body: { error?: string; detail?: string; traceId?: string } | null = null;
  try {
    body = (await res.json()) as { error?: string; detail?: string; traceId?: string };
  } catch {
    /* not JSON */
  }
  return {
    status: res.status,
    error: body?.error ?? `http_${res.status}`,
    detail: body?.detail,
    traceId: body?.traceId,
  };
}

/** GET. Returns parsed JSON; throws FetchError on non-2xx. */
export async function get<T>(path: string): Promise<T> {
  const base = resolveApiBase();
  const res = await fetch(`${base}${path}`, { credentials: 'include' });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** Generic JSON-body method (POST / PATCH / DELETE). */
async function method<T>(verb: string, path: string, body?: unknown): Promise<T> {
  const base = resolveApiBase();
  const init: RequestInit = {
    method: verb,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw await parseError(res);
  // 204 has no body.
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const post = <T>(path: string, body: unknown) => method<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => method<T>('PATCH', path, body);
export const del = <T>(path: string) => method<T>('DELETE', path);
