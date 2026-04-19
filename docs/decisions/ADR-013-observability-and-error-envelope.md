# ADR-013: Observability and Canonical Error Envelope

**Status**: Accepted
**Date**: 2026-04-19
**Traces to**: FR-36, FR-37, FR-38, FR-39

## Context

The Worker runs the public API surface for the voter-info-widget in four environments. When a user reports "the widget is slow" or "I got an error," operators have no way to correlate the browser-side action with the Worker's logs or upstream latency. Workers Logs is on (`[observability] enabled = true` in `wrangler.toml`), but each log line is an island — we cannot reconstruct "this user's click triggered these seven upstream fetches, one of which 429'd."

Error handling is likewise fragmented: the Worker emits at least three distinct error shapes (`{ error: 'upstream_error', status, upstream }` from `normalizeUpstreamErrorBody`, short plain-text responses for origin-denial and rate-limit, free-form `new Response(...)` bodies for edge cases). The widget cannot branch reliably on error cause.

The user's go-live on 2026-04-18 exposed both gaps: upstream 429s from Congress.gov surfaced as opaque widget errors, and we spent debugging cycles pattern-matching timestamps across Workers Logs and the CF dashboard to correlate events.

## Decision

Three coordinated changes, landed together:

1. **Per-request trace IDs (FR-36).** A `tr_<16hex>` ID is generated at the Worker's edge (or echoed from a validated client-supplied header), propagated to every upstream fetch the Worker makes, stamped into every log line and analytics data point for that request, and returned to the client via `X-Trace-Id`. The widget surfaces the trace ID in error UIs so users can quote it when reporting bugs.

2. **Canonical error envelope (FR-37).** Every non-2xx, non-304 Worker response with a body uses a single envelope:
   ```json
   { "error": { "code", "message", "userMessage", "upstream", "retryable", "traceId" } }
   ```
   `code` is a closed enumeration of 9 values. `retryable` drives widget UI ("Try again" button vs. not). `userMessage` is safe for direct display; `message` is operator context. No legacy dual-shape window — this is a fall-over deployment and the only consumer of these bodies is our own widget.

3. **Workers Analytics Engine (FR-38) + structured logs (FR-39).** One `writeDataPoint` per `/api/*` request, fired via `ctx.waitUntil`, carrying `[routeClass, upstreamName, errorCode, env, cacheTier]` blobs, `[totalLatencyMs, upstreamLatencyMs, statusCode, rateLimitRemaining]` doubles, and `[traceId]` index. Free-text logs are replaced with a `logEvent(ctx, { event, level, ...fields })` helper that emits JSON-per-line via `console.log`. CF indexes JSON fields automatically.

## Alternatives considered

**External APM (Honeycomb, Datadog, Grafana).** Rejected for v2.6.0 scope. Requires a second Worker to tail events + an external account + egress. Workers Analytics Engine gives us queryable time-series in the CF dashboard at zero external dependency and zero marginal cost. If we outgrow AE (unlikely — 100M writes/day free tier), we revisit with a dedicated ADR.

**Per-user-action trace IDs instead of per-request.** Rejected. Threading a trace ID through React state for the lifetime of a user's click adds widget complexity for marginal observability gain. The common case ("which upstream slow-burned this request") is per-request. If we later want action-level correlation, we can add a parent-trace header without breaking the per-request design.

**Keep legacy error shape with a compatibility alias.** Rejected. Dual-shape support doubles test surface area and permanently ossifies the mistake. No external consumer reads our error bodies — the widget is the sole client. Cut over.

**Tail Workers (tier 3, real distributed tracing).** Deferred. Not rejected on merits; just out of scope for this ADR. When/if we add an external sink, it plugs into the structured logs + trace IDs this ADR establishes.

## Consequences

### Positive

- One-line filter in CF dashboard: `traceId:tr_abc...` returns the full request's logs + analytics rows.
- Users can paste a trace ID from the widget into a bug report; operator finds the request in <30 seconds.
- First-class error handling — widget branches UI on `retryable`, users get coherent messages.
- Analytics Engine gives us "429 rate by upstream this week" in one SQL query.
- Zero external vendors.

### Negative / costs

- Every Worker response path that currently emits an ad-hoc error body has to migrate to the envelope. ~15 call sites across `proxy/lib.ts` (or whatever replaces it post-FR-42).
- Widget error-rendering code grows: it now parses the envelope, branches on `retryable`, surfaces the trace ID. Three components affected.
- AE writes consume Worker CPU budget (trivial — `writeDataPoint` is microseconds).
- Structured logs are less readable by eyeball than free-form. Pro-tip for devs: `wrangler tail --format pretty` exists for local dev.

### Rate-limit interaction

AE writes are NOT rate-limited by the Worker's `RATE_LIMITER` binding — they're internal telemetry, not inbound traffic. Zone-level limits do not apply.

## Implementation notes

- Tests for trace propagation: assert that `X-Trace-Id` header round-trips, that generated IDs match the pattern, that malformed client-supplied headers are replaced.
- Tests for error envelope: every `code` value has at least one test covering its `retryable` value + a sample response body.
- Tests for analytics: inject a fake `ANALYTICS` binding, assert `writeDataPoint` is called exactly once per request with expected fields, assert `waitUntil` was used.
- Tests for logs: capture `console.log` output, parse as JSON, assert fields.

## Related

- ADR-014 (tiered cache) consumes the `cacheTier` blob value — errors there flow through FR-37 envelope.
- ADR-015 (proxy module refactor) places these modules under `proxy/observability/`.
- FR-42 AC-42.3 (dependency injection): observability is injected into route handlers, not accessed globally.
