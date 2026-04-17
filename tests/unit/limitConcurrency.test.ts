/**
 * Concurrency Limiter Tests
 * Traces to: NFR-5
 */
import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../../src/utils/limitConcurrency';

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more than limit concurrent tasks', async () => {
    let active = 0;
    let maxObserved = 0;
    const input = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(input, 3, async (n) => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(0);
  });

  it('handles empty input', async () => {
    const result = await mapWithConcurrency([], 5, async (n) => n);
    expect(result).toEqual([]);
  });

  it('handles limit greater than input size', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
    expect(result).toEqual([2, 4]);
  });
});
