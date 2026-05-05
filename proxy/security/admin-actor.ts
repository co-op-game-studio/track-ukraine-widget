/**
 * Admin actor extraction (FR-50, revised 2026-05-02).
 *
 * Cloudflare Access at the edge is the primary authentication boundary.
 * The Worker does NOT re-implement allowlists or session state.
 *
 * What the Worker DOES do, as belt-and-suspenders defense against direct-
 * origin bypass (e.g. an attacker who finds a `*.workers.dev` URL or a
 * misconfigured DNS path that skips the Access app and forges the email
 * header): it independently verifies the `Cf-Access-Jwt-Assertion` JWT
 * against Cloudflare's JWKS, with `aud` and `iss` claim checks. The email
 * is read from the verified JWT claims, NOT from the loose
 * `Cf-Access-Authenticated-User-Email` header (which is unsigned plaintext
 * and trivially spoofable on a misconfigured route).
 *
 * Returns either `{ email }` on success, or a JSON Response with the FR-37
 * error envelope on failure. Callers propagate the Response unchanged.
 *
 * Failure modes:
 *   - Missing `Cf-Access-Jwt-Assertion` → 401 admin_jwt_required
 *   - Bad signature / aud / iss / exp → 401 admin_jwt_invalid
 *   - JWKS unreachable → 503 admin_jwks_unavailable
 *   - Missing CF_ACCESS_TEAM / CF_ACCESS_AUD env config → 500 admin_misconfigured
 *   - Verified JWT lacks `email` claim → 500 admin_actor_missing
 *
 * Traces to FR-50 AC-50.1, AC-50.2, ADR-017.
 */
import type { ProxyEnv } from '../env';
import { jsonResponse } from '../routes/common';
import {
  verifyCfAccessJwt,
  ACCESS_JWT_HEADER,
  type VerifyConfig,
} from './cf-access-jwt';

export { ACCESS_JWT_HEADER };

/** Plain header CF Access also sets — we keep the name exported for tests
 *  but DO NOT use the value for actor identity. */
export const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

export interface AdminActor {
  email: string;
}

export async function extractAdminActor(
  request: Request,
  env: ProxyEnv,
  extraHeaders: HeadersInit = {},
): Promise<AdminActor | Response> {
  if (!env.CF_ACCESS_TEAM || !env.CF_ACCESS_AUD) {
    return jsonResponse(
      500,
      {
        error: 'admin_misconfigured',
        detail:
          'CF_ACCESS_TEAM / CF_ACCESS_AUD env config is required on admin routes.',
      },
      extraHeaders,
    );
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) {
    return jsonResponse(
      401,
      {
        error: 'admin_jwt_required',
        detail:
          'Cf-Access-Jwt-Assertion header is required on admin routes. ' +
          'Confirm Cloudflare Access is gating this path.',
      },
      extraHeaders,
    );
  }

  const cfg: VerifyConfig = {
    team: env.CF_ACCESS_TEAM,
    aud: env.CF_ACCESS_AUD,
    kv: env.KV_VOTER_INFO,
  };

  const result = await verifyCfAccessJwt(token, cfg);
  if (!result.ok) {
    if (result.reason === 'jwks_unavailable') {
      return jsonResponse(
        503,
        {
          error: 'admin_jwks_unavailable',
          detail: 'Could not load Cloudflare Access JWKS. Retry shortly.',
        },
        extraHeaders,
      );
    }
    return jsonResponse(
      401,
      {
        error: 'admin_jwt_invalid',
        detail: result.reason,
      },
      extraHeaders,
    );
  }

  // User tokens carry `email`; service tokens carry `common_name` instead.
  const email = result.claims.email
    ?? result.claims.common_name;
  if (!email || typeof email !== 'string' || email.length === 0) {
    return jsonResponse(
      500,
      {
        error: 'admin_actor_missing',
        detail:
          'Verified Cloudflare Access JWT did not carry an email or common_name claim. ' +
          'Check the Access app configuration.',
      },
      extraHeaders,
    );
  }

  return { email: email.trim().toLowerCase() };
}

export function isAdminActor(v: AdminActor | Response): v is AdminActor {
  return !(v instanceof Response);
}
