/**
 * AC-52.66 — Congressional Record citation extraction from action text.
 *
 * Congress.gov's `/v3/bill/.../actions` doesn't reliably populate the
 * structured `congressionalRecord.url` / `.citation` fields, so we extract
 * the citation by regex from `action.text` instead.
 */
import { describe, it, expect } from 'vitest';
import { extractCongressionalRecord } from '../../proxy/services/import-bill';

describe('extractCongressionalRecord (AC-52.66)', () => {
  it('extracts citation from "(text: CR Hxxxx-xxxx)" form', () => {
    const r = extractCongressionalRecord(
      'Table motion to reconsider second divided question Agreed to by the Yeas and Nays: 249 - 180 (Roll no. 68). (text: CR H1405-1407)',
    );
    expect(r).toEqual({ citation: 'H1405-1407', url: null });
  });

  it('extracts citation from a bare CR reference', () => {
    const r = extractCongressionalRecord('Discussed in CR S5092 prior to vote.');
    expect(r).toEqual({ citation: 'S5092', url: null });
  });

  it('extracts from "Page Sxxxx" form', () => {
    const r = extractCongressionalRecord('Statements on introduced bills and joint resolutions; see Page S1234.');
    expect(r).toEqual({ citation: 'S1234', url: null });
  });

  it('returns null citation + null url when no CR ref present', () => {
    const r = extractCongressionalRecord('Referred to the Committee on Foreign Affairs.');
    expect(r).toEqual({ citation: null, url: null });
  });

  it('handles null/empty input gracefully', () => {
    expect(extractCongressionalRecord(null)).toEqual({ citation: null, url: null });
    expect(extractCongressionalRecord('')).toEqual({ citation: null, url: null });
  });

  it('matches first CR ref when multiple are present', () => {
    const r = extractCongressionalRecord('Combined statement; see CR H1000 and Page S2000.');
    expect(r.citation).toBe('H1000');
  });

  it('extracts E-prefix (extensions of remarks) refs too', () => {
    const r = extractCongressionalRecord('Submitted into Extensions of Remarks; see CR E1234.');
    expect(r.citation).toBe('E1234');
  });
});
