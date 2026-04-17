/**
 * Formatting Utilities
 * Traces to: T-003
 */

const BILL_TYPE_MAP: Record<string, string> = {
  HR: 'H.R.',
  S: 'S.',
  HJRES: 'H.J.Res.',
  SJRES: 'S.J.Res.',
  HCONRES: 'H.Con.Res.',
  SCONRES: 'S.Con.Res.',
  HRES: 'H.Res.',
  SRES: 'S.Res.',
};

export function formatDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year!, month! - 1, day);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatBillNumber(type: string, number: string): string {
  const prefix = BILL_TYPE_MAP[type] ?? type;
  return `${prefix} ${number}`;
}

export function formatPercentage(value: number | null): string {
  if (value === null) return 'N/A';
  if (Number.isInteger(value)) return `${value}%`;
  return `${parseFloat(value.toFixed(1))}%`;
}
