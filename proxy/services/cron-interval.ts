/**
 * Derive the polling staleness window from the cron schedule.
 *
 * Cloudflare Workers don't expose the configured cron triggers to runtime code,
 * so this module re-parses the schedule string declared in `wrangler.toml` (and
 * mirrored into env var `SOCIAL_POLL_CRON`) to compute the natural staleness
 * window: how many minutes pass between scheduled invocations.
 *
 * The staleness gate then uses `interval - safetyMin` so:
 *   - A manual admin poll within the same cron cycle skips already-polled
 *     handles (no double-pull, no wasted upstream quota).
 *   - The next scheduled cron tick is still slightly past the cutoff and
 *     re-polls everyone.
 *
 * Only the patterns we actually use in this project are supported. Anything
 * exotic falls back to the default. Unit-testable: no I/O, no globals.
 */

/** Default cron when env var is unset. Matches the historical hourly tick. */
const DEFAULT_CRON = '0 * * * *';
/** Default staleness if parsing fails — paranoia floor, never returns 0. */
const FALLBACK_INTERVAL_MIN = 60;
/**
 * Margin subtracted from the raw interval to produce the staleness window.
 * 5 min comfortably covers cron jitter (CF schedules are ±a few seconds in
 * practice, but this leaves room for slow ticks) without missing a real cycle.
 */
const SAFETY_MARGIN_MIN = 5;

// Parse a 5-field cron string into the polling interval (in minutes).
// Recognized patterns (slash-N spelled out so this comment doesn't break the parser):
//   "STAR-slash-N STAR STAR STAR STAR" — every n minutes      → n
//   "M STAR STAR STAR STAR"            — once an hour at min m → 60
//   "M STAR-slash-N STAR STAR STAR"    — every n hours        → n*60
//   "M H STAR STAR STAR"               — once a day at h:m    → 1440
// Falls back to FALLBACK_INTERVAL_MIN for anything else (better than crashing).
export function cronToIntervalMin(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return FALLBACK_INTERVAL_MIN;
  const [min, hour] = fields;
  if (min === undefined || hour === undefined) return FALLBACK_INTERVAL_MIN;

  // Every-N-minutes: `*/N * * * *`
  const minStep = /^\*\/(\d+)$/.exec(min);
  if (minStep && hour === '*') {
    const n = Number.parseInt(minStep[1]!, 10);
    return Number.isFinite(n) && n > 0 ? n : FALLBACK_INTERVAL_MIN;
  }

  // Single minute, every hour: `M * * * *` → 60 min
  if (/^\d+$/.test(min) && hour === '*') return 60;

  // Single minute, every-N-hours: `M */N * * *`
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(min) && hourStep) {
    const n = Number.parseInt(hourStep[1]!, 10);
    return Number.isFinite(n) && n > 0 ? n * 60 : FALLBACK_INTERVAL_MIN;
  }

  // Single minute, single hour: once a day → 1440 min
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) return 24 * 60;

  return FALLBACK_INTERVAL_MIN;
}

/**
 * Compute the effective staleness window in minutes for the social poll gate.
 * Reads the cron schedule from env, parses it, and subtracts the safety margin.
 * Always returns a positive integer — never 0 (which would defeat the gate).
 */
export function getSocialPollStalenessMin(env: { SOCIAL_POLL_CRON?: string }): number {
  const cron = env.SOCIAL_POLL_CRON?.trim() || DEFAULT_CRON;
  const interval = cronToIntervalMin(cron);
  const window = interval - SAFETY_MARGIN_MIN;
  return Math.max(1, window);
}
