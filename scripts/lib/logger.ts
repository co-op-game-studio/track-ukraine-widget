/**
 * CliLogger — operator-facing stdout/stderr logger for `lw` subcommands.
 *
 * Verbosity model:
 *   quiet (default)  — one summary line per item + final totals
 *   verbose (-v)     — per-phase breakdowns + timing + counters + trace IDs
 *   debug   (-d)     — verbose + raw upstream URLs (key-redacted) + status codes
 *
 * Operator use case: monitor a backfill run, diagnose where it stalls,
 * grep for failures. NOT the same as the structured `audit_log` writes
 * — those are the runtime contract; this is the human-facing surface.
 *
 * Every line includes a level marker so `grep '\[WARN\]' run.log` finds
 * what you need without parsing. The format intentionally stays simple
 * (no JSON, no timestamps for `info` — CI prepends its own).
 */

export type Verbosity = 'quiet' | 'verbose' | 'debug';

export interface CliLogger {
  verbosity: Verbosity;
  /** Always printed. Use for end-of-run summaries + critical user-facing info. */
  info(msg: string): void;
  /** Printed only when verbosity >= verbose. Use for per-item / per-phase progress. */
  verbose(msg: string): void;
  /** Printed only when verbosity >= debug. Use for raw URLs, payload sizes,
   *  SQL statement counts. Key/secret values are NEVER logged here. */
  debug(msg: string): void;
  /** Always printed to stderr. Warnings the operator must see. */
  warn(msg: string): void;
  /** Always printed to stderr. Errors before exit. */
  error(msg: string): void;
  /** Structured event hook — compatible with importBillCore's `log` callback.
   *  Routes via verbose() by default; if the event has level=error/warn,
   *  routes via the matching channel. */
  event(e: { event: string; level?: string } & Record<string, unknown>): void;
}

/**
 * Read the verbosity level set by the top-level CLI (--verbose / --debug
 * options propagate via LW_VERBOSITY env var so subcommands don't have to
 * thread the flag through every call signature).
 */
export function verbosityFromEnv(): Verbosity {
  const raw = (typeof process !== 'undefined' ? process.env?.LW_VERBOSITY : '') || '';
  if (raw === 'debug') return 'debug';
  if (raw === 'verbose') return 'verbose';
  return 'quiet';
}

/**
 * Standard stdout logger. Reads verbosity from LW_VERBOSITY env var unless
 * opts.verbosity overrides.
 */
export function makeCliLogger(opts: { verbosity?: Verbosity } = {}): CliLogger {
  const verbosity: Verbosity = opts.verbosity ?? verbosityFromEnv();
  const rank: Record<Verbosity, number> = { quiet: 0, verbose: 1, debug: 2 };
  const cur = rank[verbosity];

  function write(level: 'INFO' | 'VERBOSE' | 'DEBUG' | 'WARN' | 'ERROR', msg: string): void {
    const target = level === 'WARN' || level === 'ERROR' ? process.stderr : process.stdout;
    target.write(`[${level}] ${msg}\n`);
  }

  return {
    verbosity,
    info(msg) {
      write('INFO', msg);
    },
    verbose(msg) {
      if (cur >= rank.verbose) write('VERBOSE', msg);
    },
    debug(msg) {
      if (cur >= rank.debug) write('DEBUG', msg);
    },
    warn(msg) {
      write('WARN', msg);
    },
    error(msg) {
      write('ERROR', msg);
    },
    event(e) {
      const { event, level, ...rest } = e;
      const restStr = Object.keys(rest).length
        ? ' ' + Object.entries(rest).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')
        : '';
      const line = `${event}${restStr}`;
      if (level === 'error') {
        write('ERROR', line);
      } else if (level === 'warn') {
        write('WARN', line);
      } else if (cur >= rank.verbose) {
        write('VERBOSE', line);
      }
    },
  };
}

/**
 * Format a value for log output. Strings get quoted only if they contain
 * spaces; everything else gets JSON.stringify so objects/arrays are readable.
 */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    return /\s/.test(v) ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
