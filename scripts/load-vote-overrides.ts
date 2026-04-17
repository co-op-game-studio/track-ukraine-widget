/**
 * Parse scripts/vote-overrides.yaml into a Map keyed by
 * `${chamber}|${congress}|${session}|${rollCall}` → override object.
 *
 * No YAML dep — the file shape is narrow enough (flat list of entries,
 * scalar values, optional `>`-folded notes) that a small hand-written
 * scanner suffices and avoids pulling in 200KB of YAML library.
 *
 * See spec.md FR-22.
 */
import { readFileSync, existsSync } from 'node:fs';

export type Chamber = 'Senate' | 'House';

export interface VoteOverride {
  chamber: Chamber;
  congress: number;
  session: number;
  rollCall: number;
  /** Optional bill reference — documentation only, not used for lookup. */
  bill?: string;
  /** If set, overrides the classifier's weight. */
  weight?: number;
  /** If set, overrides the classifier's directionMultiplier. */
  directionMultiplier?: -1 | 0 | 1;
  /** If set, overrides the classifier's kind string. */
  kind?: string;
  /** Free-text rationale (folded YAML note). Displayed in curator logs. */
  note?: string;
}

export type VoteOverrideMap = Map<string, VoteOverride>;

/** Partial entry being built by the parser — every field is optional. */
type ParsedEntry = Partial<VoteOverride> & Record<string, unknown>;

export function loadVoteOverrides(path: string): VoteOverrideMap {
  if (!existsSync(path)) return new Map();
  const text = readFileSync(path, 'utf8');

  const entries: ParsedEntry[] = [];
  let current: ParsedEntry | null = null;
  let foldedKey: string | null = null;
  let foldedLines: string[] | null = null;
  let foldedIndent = 0; // column of the `key: >` anchor

  const flushFolded = (): void => {
    if (foldedKey && current && foldedLines) {
      current[foldedKey] = foldedLines.join(' ').replace(/\s+/g, ' ').trim();
    }
    foldedKey = null;
    foldedLines = null;
    foldedIndent = 0;
  };

  const pushCurrent = (): void => {
    flushFolded();
    if (current) entries.push(current);
    current = null;
  };

  const getIndent = (line: string): number => {
    const m = line.match(/^(\s*)/);
    return m ? m[1]!.length : 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // If we're in a folded block, decide whether this line ends it.
    // End on: new entry, a comment at/below the anchor indent, or any
    // non-blank line whose indent ≤ anchor indent.
    if (foldedKey) {
      const indent = getIndent(rawLine);
      const trimmed = rawLine.trim();
      const isBlank = trimmed === '';
      const isComment = trimmed.startsWith('#');
      const isNewEntry = /^\s*-\s/.test(rawLine);

      if (isNewEntry || (isComment && indent <= foldedIndent) || (!isBlank && indent <= foldedIndent)) {
        flushFolded();
        // fall through and re-process this line normally
      } else if (isBlank) {
        foldedLines!.push('');
        continue;
      } else {
        foldedLines!.push(trimmed);
        continue;
      }
    }

    // Strip trailing inline comments outside folded blocks
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^overrides\s*:\s*$/.test(line)) continue;

    const newEntry = line.match(/^\s*-\s+(\w+)\s*:\s*(.*)$/);
    if (newEntry) {
      pushCurrent();
      current = {};
      const [, key, val] = newEntry as unknown as [string, string, string];
      assignField(current, key, val);
      continue;
    }

    const foldedHead = line.match(/^(\s+)(\w+)\s*:\s*>\s*$/);
    if (foldedHead) {
      flushFolded();
      foldedIndent = foldedHead[1]!.length;
      foldedKey = foldedHead[2]!;
      foldedLines = [];
      continue;
    }

    const kv = line.match(/^\s+(\w+)\s*:\s*(.*)$/);
    if (kv && current) {
      const [, key, val] = kv as unknown as [string, string, string];
      assignField(current, key, val);
    }
  }
  pushCurrent();

  const map: VoteOverrideMap = new Map();
  for (const entry of entries) {
    const { chamber, congress, session, rollCall } = entry;
    if (
      (chamber !== 'Senate' && chamber !== 'House') ||
      typeof congress !== 'number' ||
      typeof session !== 'number' ||
      typeof rollCall !== 'number'
    ) {
      continue;
    }
    const key = `${chamber}|${congress}|${session}|${rollCall}`;
    map.set(key, entry as VoteOverride);
  }
  return map;
}

function assignField(obj: ParsedEntry, key: string, rawVal: string): void {
  const val = rawVal.trim();
  if (val === '') return;
  if (/^-?\d+(\.\d+)?$/.test(val)) {
    obj[key] = Number(val);
    return;
  }
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    obj[key] = val.slice(1, -1);
    return;
  }
  obj[key] = val;
}

export function lookupOverride(
  overrides: VoteOverrideMap,
  chamber: Chamber,
  congress: number,
  session: number,
  rollCall: number,
): VoteOverride | null {
  return overrides.get(`${chamber}|${congress}|${session}|${rollCall}`) ?? null;
}
