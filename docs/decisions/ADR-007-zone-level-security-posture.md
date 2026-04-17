# ADR-007: Zone-Level Security Posture (v2.5.0)

**Status**: Accepted
**Date**: 2026-04-17
**Context**: Completes the security pass begun in ADR-006 by committing to a specific Cloudflare-zone-level posture in front of the Worker.

## Context

ADR-006 hardened the Worker itself — origin allowlist, per-response security header baseline, upstream-path validation, API-key injection scope, error-body normalization. Those controls run *inside* the Worker. But several classes of threat are better handled at the zone layer, where they cost zero code and cannot be accidentally regressed by a Worker deploy:

- **Volumetric abuse** (scraping, quota drain). Should never reach Worker code; a single rate-limit rule is strictly cheaper than in-Worker token-bucket logic and runs before our Congress.gov budget is touched.
- **Stale TLS / protocol downgrade**. TLS version negotiation happens before HTTP is parsed. The Worker cannot enforce TLS 1.3; only CF's edge cert config can.
- **Known-bad-traffic patterns** (SQLi, XSS probes, common exploit shapes). WAF Managed Ruleset catches these at the edge with a maintained signature set. Reimplementing this in-Worker would be a multi-year rabbit hole and still be worse than CF's.
- **Known-bad-actor geographies**. Our audience is U.S. voters; Russia and Belarus have no legitimate use for this widget. Blocking at the zone level removes them from the Worker's attack surface entirely.
- **Header injection by the edge itself**. `Server: cloudflare`, `CF-RAY`, `Report-To`, `NEL` are added *after* our Worker runs and cannot be stripped in code (see ADR-006 "Cloudflare-injected headers are a zone concern"). A Transform Rule is the only way.

The Worker is strong at what it's good at — origin allowlist, per-route path validation, secret injection, cache behavior. The zone is strong at what it's good at — signature matching, rate limiting, TLS hardening, geographic filtering, response-header surgery. Committing to both makes each layer simpler, not more complex.

## Decision

Commit to the controls specified as AC-28.1 through AC-28.13, summarized:

1. **WAF Managed Rulesets** (OWASP Core) in Block mode on the Worker hostnames — AC-28.1.
2. **Bot Fight Mode** enabled with verified-bot exemptions — AC-28.2.
3. **Rate Limiting** at 100 req/min/IP on `/api/*` — AC-28.3. (Free-plan allowance is one rule; spend it here.)
4. **Transform Rules** to strip `Server`, `CF-RAY`, `Report-To`, `NEL`, `Reporting-Endpoints` — AC-28.4.
5. **TLS minimum 1.3**, Always Use HTTPS, 0-RTT off — AC-28.5, AC-28.6.
6. **Zone-level HSTS** matching the Worker's header (preload-eligible) — AC-28.7.
7. **DNSSEC** on `cogs.it.com` — AC-28.8.
8. **CAA records** restricting certificate issuance — AC-28.9.
9. **Cache Rule** to respect origin cache-control — AC-28.10.
10. **Geo-block on RU and BY** — AC-28.11.
11. **Documentation obligation**: checklist in `docs/deployment.md` with verification commands — AC-28.12.
12. **Annual review** — AC-28.13.

### Geo-block rationale (AC-28.11)

The widget's stated audience is U.S. voters looking up U.S. federal representatives. Traffic from RU or BY to `vote.cogs.it.com` is almost certainly one of: (a) recon/abuse, (b) a developer testing from a VPN (out of scope — they should use `dev.vote.cogs.it.com` with a non-RU/BY test exit), or (c) a U.S. citizen abroad using a VPN that happens to egress RU/BY (rare; they can switch exits).

Blocking both at the zone level:
- Is one firewall rule, testable with `curl -H "CF-IPCountry: RU"` hitting a test endpoint (CF does not let us spoof geo this way in prod, but the rule's match expression is simple enough to inspect-test).
- Does not hit the Worker at all on matches — zero Congress.gov quota impact for blocked traffic.
- Is reversible in one click if we ever need to carve out exceptions.

We deliberately **do not** block via Worker code. An in-Worker geo-block would require either reading CF's `cf.country` request property or calling a geo-IP service — the first ties us to CF runtime specifics (fine, we're already there, but no incremental benefit over a rule), the second adds latency and a failure mode. The zone rule is strictly simpler.

We deliberately **do not** block Crimea, Donetsk, Luhansk separately. CF geo-IP labels these inconsistently (often `UA`, sometimes `RU`, occasionally `Unknown`). Blocking `UA` would defeat the widget's audience. If CF publishes reliable sub-country geo for occupied regions, revisit.

We deliberately **do not** initially carve out an allowlist (researchers, journalists, known IP ranges). Adding an allowlist is a 5-minute dashboard edit when a concrete need surfaces, and recording that need in this ADR keeps the decision auditable.

## Consequences

**Positive:**
- Worker attack surface shrinks — rate-limited, geo-filtered, WAF-pre-screened, TLS-hardened traffic is what the Worker sees.
- Zero additional code; zero new unit tests beyond the Worker's existing suite.
- Explicit annual review (AC-28.13) prevents posture-drift — common failure mode for zone config that's set once and forgotten.
- Deployment.md becomes a runnable checklist; reduces "what did we actually configure" knowledge-loss risk.

**Negative:**
- Setting all controls requires dashboard access to the Cloudflare zone. Cannot be done entirely from CI without the Cloudflare Terraform provider (not adopted yet; documented as a future option in "Revisit when").
- Rate-limit false positives possible if a single legitimate embedder site routes all voter traffic through one NAT gateway (e.g., a corporate network hosting an info session). Mitigation: check rate-limit-block analytics weekly for the first month; adjust threshold per real data.
- Geo-block will occasionally frustrate a U.S. citizen on a Russian VPN exit. The alternative (in-Worker geo with bypass flag) adds code surface; we accept the UX cost for the simplicity.

**Neutral:**
- No change to Worker code behavior. FR-27 continues to be the authoritative in-code spec; FR-28 sits in front of it.
- Free-plan rate-limit allowance is one rule. If we later need a second (e.g., stricter limit on `/api/congress/*` specifically), we either stack rules on Pro plan or accept that this rule is the ceiling.

## Deliberate non-goals

Explicitly **not adopted** from the security menu evaluated in the 2026-04-17 review:
- **Page Shield** — limited value for our surface (the embedder owns the document; we serve a subresource). Revisit if we ever host a first-party page.
- **Turnstile** — no form / admin surface exists. Will adopt when one does.
- **Cloudflare Access on prod hostnames** — incompatible with public embedding. See ADR-006 re: Access only belongs on internal/admin surfaces.
- **ASN blocklists for scraper clouds (GCP, AWS, etc.)** — too prone to false positives (legitimate serverless integrations may originate from these ASNs). Kept in the incident-response toolkit rather than preemptive config.
- **Firewall Custom Rules (Pro tier)** — Managed Ruleset + single Rate Limit rule handle the 90th percentile. Upgrade if a real attack pattern warrants.

## Revisit when

- An incident (real or drill) reveals a control that should have blocked something and didn't — amend the relevant AC with the dated event.
- Cloudflare publishes a control we evaluated and rejected in a materially better form (e.g., Turnstile becomes available on free tier; Page Shield gets a non-document mode).
- We adopt the Cloudflare Terraform provider or another IaC approach — then the AC-28.* settings become code-enforced rather than dashboard-drifted, and this ADR graduates to a `terraform apply` artifact.
- Traffic patterns change enough that the rate-limit threshold or geo-block becomes wrong. (Either: legit load blows through 100/min/IP, or a real use case surfaces in RU/BY — unlikely but possible.)
