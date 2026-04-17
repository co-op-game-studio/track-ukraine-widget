# ADR-008: Cloudflare Access Gating of Non-Prod Environments (v2.5.0)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Following the zone-level hardening in ADR-007, the project still has three Worker hostnames (`dev.vote.cogs.it.com`, `uat.vote.cogs.it.com`, `stg.vote.cogs.it.com`) publicly reachable with weaker defensive posture than prod.

## Context

The non-prod environments exist to stage pre-release code, rehearse deploys, and let reviewers smoke-test changes before they hit prod. They are intentionally weaker than prod:

- `dev.vote.cogs.it.com` has `ALLOWED_ORIGINS` widened to include localhost variants and `ALLOW_LOCALHOST=true`, so a localhost page can hit it.
- All three share the same Congress.gov API key pool via separate Worker secrets, but an attacker burning quota on one env burns it from the same upstream budget.
- Pre-release code is, by definition, less reviewed. A non-prod Worker may carry a bug that prod doesn't have yet.

Leaving them publicly reachable has three downsides:

1. **Soft-target attack surface.** An attacker who finds a vulnerability in a non-prod build gets the same upstream credentials and the same quota impact as if they'd found it in prod.
2. **Pre-release visibility.** Anyone who watches DNS for `*.vote.cogs.it.com` can observe the cadence of non-prod deploys and probe their endpoints for shape differences from prod — useful intel for an attacker planning a prod attack.
3. **No graduation story for internal surfaces.** If we ever build a curator dashboard, admin UI, or data-review tool, it will need to live somewhere. A working Access gate on existing non-prod hostnames establishes the pattern without having to figure it out under pressure.

Prod must remain public. The widget is a third-party embed on trackukraine.com; voters cannot pass an Access login.

## Decision

Put a single Cloudflare Access Application (`voter-info-widget-nonprod`) in front of the three non-prod hostnames. Prod hostname does not appear in any Access Application. Access authenticates humans via one-time-PIN email initially (upgradeable to SSO later), and authenticates automation via a Service Token.

### Architecture

```
Embedder browser → trackukraine.com (public) → https://vote.cogs.it.com (PROD, public Worker)
                                                    └─ zone-level WAF/rate-limit/geo/etc (ADR-007)
                                                    └─ in-Worker controls (ADR-006)

Developer (kody@…)  → https://dev.vote.cogs.it.com → CF Access challenge → OTP email →
                      Access JWT cookie (24h) → dev Worker

GitHub Actions (CI) → https://dev.vote.cogs.it.com with
                      CF-Access-Client-Id + CF-Access-Client-Secret headers → dev Worker
```

### Decisions inside the decision

**Single Application vs. three.** One Application covering three hostnames, one policy. Three Applications would require three identical policy-edits on every change and one is guaranteed to drift. Multi-hostname per Application is a first-class CF feature and costs nothing.

**OTP email as IdP.** Zero external dependency. A real IdP (Google Workspace, GitHub SSO, Okta) is strictly better for a team but overkill for a solo developer, and the migration is a policy edit — no architectural change. Deferred until one of the AC-29.4 conditions fires.

**Service token for CI, not for developers.** A single service token is simpler than per-developer tokens for local work — developers use `cloudflared access login`, which caches a JWT for the session-duration (24h). This keeps the service token restricted to non-human use and makes stolen-secret detection easier (any human-shaped traffic presenting the service token is a red flag).

**Session duration = 24h.** Matches a working day plus overnight. Shorter (e.g., 8h) would force re-auth during a single debugging session, which trains developers to leave sessions in "remember-me" modes that defeat the purpose. Longer (e.g., 1 week) extends stolen-cookie blast radius without meaningful UX benefit.

**`*.workers.dev` disabled.** Any enabled `workers.dev` URL bypasses the custom domain entirely — no zone-level WAF, no Access, no Transform Rules, nothing. Captured as AC-28.14.

**CI deploy auth is orthogonal to Access.** `wrangler deploy` authenticates to the **Workers control plane API** via `CLOUDFLARE_API_TOKEN`. Access gates the **Worker's HTTP surface** at the edge. They're different channels; gating the HTTP surface does not affect deploy capability. This is surprising to people who assume "everything goes through Access" — captured as AC-29.7 so it's explicit.

**E2E testing strategy.** Support both local (`wrangler dev`) and remote (real gated CF edge) modes. Local runs on every PR as the inner loop; remote runs post-deploy as a verification gate. Remote tests carry the service token. Captured as AC-29.9.

## Consequences

**Positive:**

- Non-prod attack surface contracts from "the entire internet" to "humans on the allow list + one service token." Soft-target scenario closed.
- Service token is a single pivot point for granting/revoking CI access — rotate it and every automation using it breaks (good: forces visibility).
- Establishes the pattern for any future internal-only surface (curator UI, review dashboard) — add hostname to the Application, done.
- Zero cost on prod: prod remains public; the widget continues to embed on trackukraine.com without change.
- Pre-release deploy cadence stops leaking via public probes.

**Negative:**

- Developer UX for non-prod requires `cloudflared access login <host>` the first time and periodic re-auth. Low friction in practice (one command per 24h) but real.
- CI workflow updates needed: any `curl` or Playwright step targeting `dev/uat/stg` hostnames must carry service-token headers. Captured as a concrete checklist in `docs/deployment.md`.
- If the service token is ever compromised, all three non-prod envs are exposed until rotation. Mitigated by AC-29.11 (annual rotation, 24h-on-suspicion rotation).
- Access challenge pages are Cloudflare's — they don't carry our FR-27 security-header baseline. Acceptable because they never carry data, but it means automated scanners will see "CF Access challenge" on non-prod endpoints and report it differently from prod.

**Neutral:**

- No Worker code changes required. The Worker never knows whether Access was in front of it; it just sees authenticated requests.
- Zone-level controls (WAF, rate limit, geo-block, Transform Rules) still apply to non-prod — Access runs before them too but the surviving requests are further filtered. Defense in depth remains intact.

## Explicit non-goals

- **Mutual TLS for non-prod.** A valid hardening option (require client certs at the Access layer) but overkill for solo-dev / small-team scale and forecloses the OTP fallback. Revisit at team size ≥ 5.
- **Per-environment Applications.** Three Applications with identical policies is worse, not better. Revisit if environments ever diverge in who can access them.
- **Access on prod.** Captured as AC-29.6 non-negotiable. Prod is a public embed surface by architectural requirement.
- **Blocking non-authenticated probes from appearing in zone analytics.** Access logs them as "blocked" in Zero Trust audit; zone-level WAF may also see them. Overlap is fine; telemetry is cheap.

## Revisit when

- Team grows past ~3 people → migrate IdP to SSO (AC-29.4).
- A real internal surface exists (admin/curator/review UI) → add its hostname to the same Application; the pattern transfers unchanged.
- Incident reveals the service token leaked → rotate under AC-29.11 and consider splitting CI into multiple narrower tokens.
- Access introduces a materially better authentication mode we should adopt (passkeys, hardware-backed identity) — amend AC-29.4.
