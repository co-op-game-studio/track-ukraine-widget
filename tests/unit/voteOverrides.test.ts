/**
 * Vote override loader tests — FR-22.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVoteOverrides, lookupOverride } from '../../scripts/load-vote-overrides';

let tempDir: string;
let samplePath: string;
let emptyPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vote-overrides-test-'));
  samplePath = join(tempDir, 'overrides.yaml');
  emptyPath = join(tempDir, 'missing.yaml'); // intentionally not created

  writeFileSync(
    samplePath,
    [
      '# Header comment',
      'overrides:',
      '',
      '  - chamber: Senate',
      '    congress: 118',
      '    session: 2',
      '    rollCall: 39',
      '    bill: HR815',
      '    weight: 0',
      '    note: >',
      '      Feb 7 2024 cloture — ambiguous without iteration context.',
      '      Zero out.',
      '',
      '  - chamber: House',
      '    congress: 117',
      '    session: 2',
      '    rollCall: 141',
      '    weight: 1.0',
      '    directionMultiplier: 1',
      '    kind: passage',
      '',
      '  - chamber: Senate',
      '    congress: 118',
      '    session: 2',
      '    rollCall: 41',
      '    directionMultiplier: 0',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('loadVoteOverrides', () => {
  it('parses all three entries', () => {
    const overrides = loadVoteOverrides(samplePath);
    expect(overrides.size).toBe(3);
  });

  it('parses numeric fields as numbers', () => {
    const overrides = loadVoteOverrides(samplePath);
    const entry = lookupOverride(overrides, 'Senate', 118, 2, 39);
    expect(entry).not.toBeNull();
    expect(entry!.weight).toBe(0);
    expect(typeof entry!.weight).toBe('number');
    expect(entry!.congress).toBe(118);
    expect(entry!.rollCall).toBe(39);
  });

  it('parses the folded multi-line note as a single string', () => {
    const overrides = loadVoteOverrides(samplePath);
    const entry = lookupOverride(overrides, 'Senate', 118, 2, 39);
    expect(entry!.note).toMatch(/Feb 7 2024 cloture/);
    expect(entry!.note).toMatch(/iteration context/);
    // Should be a single line (folded)
    expect(entry!.note).not.toContain('\n');
  });

  it('parses string fields like kind', () => {
    const overrides = loadVoteOverrides(samplePath);
    const entry = lookupOverride(overrides, 'House', 117, 2, 141);
    expect(entry!.kind).toBe('passage');
    expect(entry!.weight).toBe(1);
    expect(entry!.directionMultiplier).toBe(1);
  });

  it('supports directionMultiplier: 0 without requiring a weight', () => {
    const overrides = loadVoteOverrides(samplePath);
    const entry = lookupOverride(overrides, 'Senate', 118, 2, 41);
    expect(entry!.directionMultiplier).toBe(0);
    // weight was not set — should be undefined
    expect(entry!.weight).toBeUndefined();
  });

  it('returns an empty map when the file does not exist (AC-22.4)', () => {
    const overrides = loadVoteOverrides(emptyPath);
    expect(overrides.size).toBe(0);
  });

  it('lookupOverride returns null for non-matching keys', () => {
    const overrides = loadVoteOverrides(samplePath);
    expect(lookupOverride(overrides, 'Senate', 118, 2, 999)).toBeNull();
    expect(lookupOverride(overrides, 'House', 118, 2, 39)).toBeNull();
  });

  it('key lookup is chamber+congress+session+rollCall exact match', () => {
    const overrides = loadVoteOverrides(samplePath);
    expect(lookupOverride(overrides, 'Senate', 118, 2, 39)).not.toBeNull();
    expect(lookupOverride(overrides, 'House', 117, 2, 141)).not.toBeNull();
  });

  it('does not swallow trailing section-comment blocks into a folded note', () => {
    // Regression: an earlier version of the parser would keep appending
    // lines to the folded note until it saw a `- ` entry, so any trailing
    // `# ────` comment banners ended up inside the last entry's note.
    const path = join(tempDir, 'with-trailing-comments.yaml');
    writeFileSync(
      path,
      [
        'overrides:',
        '',
        '  - chamber: Senate',
        '    congress: 119',
        '    session: 1',
        '    rollCall: 5',
        '    weight: 0',
        '    note: >',
        '      This note should end cleanly.',
        '',
        '# ───────────────────────────────────────',
        '# Trailing banner — must NOT be part of the note above.',
        '# ───────────────────────────────────────',
      ].join('\n'),
      'utf8',
    );
    const overrides = loadVoteOverrides(path);
    const entry = lookupOverride(overrides, 'Senate', 119, 1, 5);
    expect(entry).not.toBeNull();
    expect(entry!.note).toBe('This note should end cleanly.');
    expect(entry!.note).not.toMatch(/banner|────/);
  });
});
