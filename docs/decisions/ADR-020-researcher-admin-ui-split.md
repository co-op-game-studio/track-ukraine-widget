# ADR-020: Researcher vs Admin UI split is cosmetic, via an `ADMIN_EMAILS` hint

- Status: Accepted
- Date: 2026-06-07
- Supersedes: none (refines the posture recorded in memory `feedback_admin_auth_at_edge`)
- Related: FR-50 (admin auth at the edge), FR-61 (researcher/admin UI split), ADR-017

## Context

The admin SPA shows one flat navigation to every signed-in user. Non-technical
researchers — the primary users — are shown operator-only surfaces (Cache, Sync
status, App config, API quota) that confuse them and are irrelevant to curation.
The product ask (4.3.0 punchlist) is a "staff → Admin divide": researchers see
only the research workflow; a small shortlist of admins additionally see the
operator/config tooling.

This bumps against an existing project rule (memory `feedback_admin_auth_at_edge`):
> CF Access gates `/admin*` + `/api/admin*`; Worker only extracts the verified
> email; **no allowlist code.**

Authorization is — and stays — at the edge. The question is only how to decide
*what the SPA renders* for whom.

## Decision

Introduce an **`ADMIN_EMAILS`** env list (comma-separated, per-env in
`wrangler.toml`). `GET /api/admin/config` returns a boolean `isAdmin` computed by
comparing the already-verified actor email against that list (case-insensitive,
trimmed; empty list ⇒ everyone is admin, fail-open). The SPA hides the Admin menu
group when `isAdmin` is false.

Crucially:

- **This is not authorization.** The Worker NEVER uses `ADMIN_EMAILS` to accept or
  reject a request. Every CF-Access-verified user remains fully authorized at the
  API layer, exactly as before. `isAdmin` is a *rendering hint* only.
- **It is not a security boundary.** A non-admin who knows a config URL can still
  hit `/api/admin/*` directly and it will succeed. That is acceptable because, per
  the project's stated posture, **all CF-Access users are trusted.** The split
  exists to declutter the UI for non-technical researchers, not to keep secrets
  from untrusted users.

## Why this doesn't violate "no allowlist code"

The original rule's intent is that *access control* must not live in app code — it
lives at CF Access. We honor that: access control is unchanged and still at the
edge. What we add is a *presentation hint* derived from the same verified email the
Worker already extracts. No request is ever allowed or denied by app code on the
basis of this list.

If a future requirement needs a real researcher-vs-admin *authorization* boundary
(not just UI), that must be done at the edge (a separate CF Access policy/group),
not by promoting this hint into an enforcement check. A new ADR should record that
change.

## Consequences

- `ADMIN_EMAILS` must be maintained per-env in `wrangler.toml`. An empty/unset
  value preserves today's behavior (everyone sees everything).
- The SPA must tolerate the brief window before `/api/admin/config` resolves by
  hiding the Admin group until `isAdmin` is known (avoids a flash of operator nav
  for researchers).
- Memory `feedback_admin_auth_at_edge` is refined, not reversed: edge auth stays;
  this ADR documents the one app-level email *hint* and why it's allowed.
