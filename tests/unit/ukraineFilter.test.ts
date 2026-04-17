/**
 * Ukraine Bill Filter Tests
 * Traces to: FR-11, FR-12, design.md §4.4b
 */
import { describe, it, expect } from 'vitest';
import {
  isCuratedBill,
  lookupCuratedBill,
  getCuratedBills,
  getCuratedVotesForChamber,
} from '../../src/services/ukraineFilter';

describe('Ukraine bill filter', () => {
  it('recognizes H.R. 7691 (117th) as curated and featured', () => {
    expect(isCuratedBill(117, 'HR', '7691')).toBe(true);
    const bill = lookupCuratedBill(117, 'HR', '7691');
    expect(bill).not.toBeNull();
    expect(bill!.featured).toBe(true);
    expect(bill!.becameLaw).toBe(true);
  });

  it('recognizes the Lend-Lease Act (S. 3522, 117th) as curated', () => {
    expect(isCuratedBill(117, 'S', '3522')).toBe(true);
  });

  it('rejects bills not in the curated set', () => {
    expect(isCuratedBill(118, 'HR', '1')).toBe(false);
    expect(isCuratedBill(119, 'S', '999')).toBe(false);
  });

  it('is case-insensitive on bill type', () => {
    expect(isCuratedBill(117, 'hr', '7691')).toBe(true);
    expect(isCuratedBill(117, 'Hr', '7691')).toBe(true);
  });

  it('getCuratedBills returns featured bills first', () => {
    const bills = getCuratedBills();
    const firstNonFeaturedIdx = bills.findIndex((b) => !b.featured);
    const lastFeaturedIdx = bills.map((b, i) => (b.featured ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(firstNonFeaturedIdx).toBeGreaterThan(lastFeaturedIdx);
  });

  it('getCuratedBills returns at least 5 featured bills', () => {
    const featured = getCuratedBills().filter((b) => b.featured);
    expect(featured.length).toBeGreaterThanOrEqual(5);
  });

  it('getCuratedBills returns roughly 27 curated bills total', () => {
    const all = getCuratedBills();
    expect(all.length).toBeGreaterThan(20);
    expect(all.length).toBeLessThan(40);
  });

  it('getCuratedVotesForChamber("House") returns House votes with billy context', () => {
    const houseVotes = getCuratedVotesForChamber('House');
    expect(houseVotes.length).toBeGreaterThan(0);
    houseVotes.forEach((v) => expect(v.vote.chamber).toBe('House'));
    // Must include the famous Lend-Lease House vote (roll call 141, 117th)
    const lendLease = houseVotes.find(
      (v) => v.vote.congress === 117 && v.vote.rollCall === 141,
    );
    expect(lendLease).toBeDefined();
  });

  it('getCuratedVotesForChamber("Senate") returns Senate votes only', () => {
    const senateVotes = getCuratedVotesForChamber('Senate');
    expect(senateVotes.length).toBeGreaterThan(0);
    senateVotes.forEach((v) => expect(v.vote.chamber).toBe('Senate'));
  });

  it('getCuratedVotesForChamber orders featured-bill votes first', () => {
    const votes = getCuratedVotesForChamber('House');
    const firstNonFeaturedIdx = votes.findIndex((v) => !v.bill.featured);
    if (firstNonFeaturedIdx === -1) return; // all featured, trivially true
    const lastFeaturedIdx = votes
      .map((v, i) => (v.bill.featured ? i : -1))
      .filter((i) => i >= 0)
      .pop()!;
    expect(firstNonFeaturedIdx).toBeGreaterThan(lastFeaturedIdx);
  });
});
