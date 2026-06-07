/**
 * Admin megamenu researcher/admin split — FR-61 AC-61.3.
 *
 * The Admin column (operator/config surfaces) is rendered only when isAdmin is
 * true; researcher columns are always present. Tested via the pure
 * `visibleColumns` selector so we don't need to stand up the whole SPA + fetch.
 */
import { describe, it, expect } from 'vitest';
import { COLUMNS, visibleColumns } from '../../src/admin/App';

describe('FR-61: megamenu researcher/admin split', () => {
  it('AC-61.3: hides the Admin column when isAdmin is false', () => {
    const headings = visibleColumns(false).map((c) => c.heading);
    expect(headings).toContain('Workspace');
    expect(headings).toContain('Curation');
    expect(headings).toContain('Help');
    expect(headings).not.toContain('Admin');
  });

  it('AC-61.3: shows the Admin column when isAdmin is true', () => {
    const headings = visibleColumns(true).map((c) => c.heading);
    expect(headings).toContain('Admin');
  });

  it('AC-61.3: hides the Admin column while isAdmin is still loading (null)', () => {
    const headings = visibleColumns(null).map((c) => c.heading);
    expect(headings).not.toContain('Admin');
  });

  it('researcher columns are always present regardless of isAdmin', () => {
    for (const v of [true, false, null] as const) {
      const headings = visibleColumns(v).map((c) => c.heading);
      expect(headings).toEqual(expect.arrayContaining(['Workspace', 'Curation', 'Help']));
    }
  });

  it('the Admin column carries the config/operator surfaces (AC-61.4)', () => {
    const admin = COLUMNS.find((c) => c.heading === 'Admin')!;
    const labels = admin.links.map((l) => l.label);
    // Config surfaces live here, not in researcher groups.
    expect(labels).toEqual(expect.arrayContaining(['Keywords', 'Tags', 'Sync status']));
  });
});
