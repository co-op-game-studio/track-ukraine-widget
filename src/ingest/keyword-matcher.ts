/**
 * Keyword matcher — runs over queue rows and tags matches.
 *
 * Pure function: takes a post body + a list of keyword watch rules, returns
 * the slugs that matched. No I/O, no side effects, easy to test.
 *
 * Traces: FR-59 (keyword watch).
 */

export interface KeywordWatch {
  watchName: string;
  pattern: string;
  isRegex: boolean;
}

/**
 * Return the watch names that match the given text.
 * Case-insensitive for plain keywords; regex watches use the pattern as-is
 * (callers store `/i` in the pattern if they want case-insensitivity).
 */
export function matchKeywords(
  text: string,
  watches: KeywordWatch[],
): string[] {
  const matched: string[] = [];
  for (const w of watches) {
    try {
      const re = w.isRegex
        ? new RegExp(w.pattern, 'i')
        : new RegExp(`\\b${escapeRegex(w.pattern)}\\b`, 'i');
      if (re.test(text)) {
        matched.push(w.watchName);
      }
    } catch {
      // Bad regex — skip silently rather than crash the batch.
    }
  }
  return matched;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
