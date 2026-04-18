/**
 * Sanitizer for URLs sourced from external APIs before they become
 * `href` / `src` attributes in the rendered DOM.
 *
 * Returns the input verbatim if it parses as an absolute `http:` or `https:`
 * URL; returns `null` for anything else (other schemes, relative URLs,
 * garbage, empty, null/undefined).
 *
 * Traces to: spec.md FR-31 AC-31.1, AC-31.2.
 */
export function sanitizeUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;
  // Reject anything with leading/trailing whitespace — historical browsers
  // tolerated whitespace before a scheme, turning `  javascript:alert(1)`
  // into an executable href. Simplest defense: require the input to already
  // be a clean URL.
  if (value !== value.trim()) return null;
  // Reject any ASCII control character (tab, newline, null, DEL, etc.).
  // Browsers strip tab/LF/CR from URLs before fetching, so the string the
  // caller gets back would not match what the browser actually requests —
  // the mismatch is a footgun for anyone logging or comparing URLs, and
  // `%00`-style null bytes can in principle confuse server-side parsers.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  // URL.protocol always ends in ':'. Accept only http / https.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return value;
}
