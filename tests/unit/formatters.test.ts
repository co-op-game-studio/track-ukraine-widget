/**
 * Formatter Utility Tests
 * Traces to: T-003
 */
import { describe, it, expect } from 'vitest';
import { formatDate, formatBillNumber, formatPercentage } from '../../src/utils/formatters';

describe('formatDate', () => {
  it('formats ISO date string to readable format', () => {
    expect(formatDate('2026-04-15')).toBe('Apr 15, 2026');
  });

  it('handles various date formats', () => {
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate('2025-12-31')).toBe('Dec 31, 2025');
  });
});

describe('formatBillNumber', () => {
  it('formats House bills', () => {
    expect(formatBillNumber('HR', '1234')).toBe('H.R. 1234');
  });

  it('formats Senate bills', () => {
    expect(formatBillNumber('S', '456')).toBe('S. 456');
  });

  it('formats House joint resolutions', () => {
    expect(formatBillNumber('HJRES', '78')).toBe('H.J.Res. 78');
  });

  it('formats Senate joint resolutions', () => {
    expect(formatBillNumber('SJRES', '12')).toBe('S.J.Res. 12');
  });

  it('formats House concurrent resolutions', () => {
    expect(formatBillNumber('HCONRES', '5')).toBe('H.Con.Res. 5');
  });

  it('formats Senate concurrent resolutions', () => {
    expect(formatBillNumber('SCONRES', '3')).toBe('S.Con.Res. 3');
  });

  it('formats House simple resolutions', () => {
    expect(formatBillNumber('HRES', '99')).toBe('H.Res. 99');
  });

  it('formats Senate simple resolutions', () => {
    expect(formatBillNumber('SRES', '42')).toBe('S.Res. 42');
  });

  it('passes through unknown types', () => {
    expect(formatBillNumber('UNKNOWN', '1')).toBe('UNKNOWN 1');
  });
});

describe('formatPercentage', () => {
  it('formats whole numbers without decimals', () => {
    expect(formatPercentage(100)).toBe('100%');
    expect(formatPercentage(0)).toBe('0%');
  });

  it('formats decimals to one place', () => {
    expect(formatPercentage(85.7)).toBe('85.7%');
    expect(formatPercentage(33.33)).toBe('33.3%');
  });

  it('returns "N/A" for null', () => {
    expect(formatPercentage(null)).toBe('N/A');
  });
});
