/**
 * FIPS Map Utility Tests
 * Traces to: FR-2, T-003
 * Tests FIPS-to-state mapping + state code/name lookups + territory detection
 */
import { describe, it, expect } from 'vitest';
import {
  fipsToStateCode,
  stateCodeToName,
  stateNameToCode,
  isTerritory,
} from '../../src/utils/fipsMap';

describe('fipsToStateCode', () => {
  it('converts Illinois FIPS 17 to IL', () => {
    expect(fipsToStateCode('17')).toBe('IL');
  });

  it('converts California FIPS 06 to CA', () => {
    expect(fipsToStateCode('06')).toBe('CA');
  });

  it('converts Wyoming FIPS 56 to WY', () => {
    expect(fipsToStateCode('56')).toBe('WY');
  });

  it('converts DC FIPS 11 to DC', () => {
    expect(fipsToStateCode('11')).toBe('DC');
  });

  it('converts Puerto Rico FIPS 72 to PR', () => {
    expect(fipsToStateCode('72')).toBe('PR');
  });

  it('returns undefined for invalid FIPS', () => {
    expect(fipsToStateCode('99')).toBeUndefined();
    expect(fipsToStateCode('')).toBeUndefined();
  });

  it('handles all 50 states', () => {
    // Spot-check a spread of states
    expect(fipsToStateCode('01')).toBe('AL');
    expect(fipsToStateCode('02')).toBe('AK');
    expect(fipsToStateCode('12')).toBe('FL');
    expect(fipsToStateCode('36')).toBe('NY');
    expect(fipsToStateCode('48')).toBe('TX');
    expect(fipsToStateCode('50')).toBe('VT');
  });
});

describe('stateCodeToName', () => {
  it('converts IL to Illinois', () => {
    expect(stateCodeToName('IL')).toBe('Illinois');
  });

  it('converts CA to California', () => {
    expect(stateCodeToName('CA')).toBe('California');
  });

  it('handles lowercase input', () => {
    expect(stateCodeToName('ny')).toBe('New York');
  });

  it('returns undefined for invalid codes', () => {
    expect(stateCodeToName('XX')).toBeUndefined();
  });

  it('handles DC', () => {
    expect(stateCodeToName('DC')).toBe('District of Columbia');
  });

  it('handles territories (PR, GU, VI, AS, MP)', () => {
    expect(stateCodeToName('PR')).toBe('Puerto Rico');
    expect(stateCodeToName('GU')).toBe('Guam');
    expect(stateCodeToName('VI')).toBe('U.S. Virgin Islands');
    expect(stateCodeToName('AS')).toBe('American Samoa');
    expect(stateCodeToName('MP')).toBe('Northern Mariana Islands');
  });
});

describe('stateNameToCode', () => {
  it('converts Illinois to IL', () => {
    expect(stateNameToCode('Illinois')).toBe('IL');
  });

  it('is case-insensitive', () => {
    expect(stateNameToCode('illinois')).toBe('IL');
  });

  it('returns undefined for unknown names', () => {
    expect(stateNameToCode('Atlantis')).toBeUndefined();
  });
});

describe('isTerritory', () => {
  it('returns true for DC', () => {
    expect(isTerritory('DC')).toBe(true);
  });

  it('returns true for PR', () => {
    expect(isTerritory('PR')).toBe(true);
  });

  it('returns true for GU, VI, AS, MP', () => {
    expect(isTerritory('GU')).toBe(true);
    expect(isTerritory('VI')).toBe(true);
    expect(isTerritory('AS')).toBe(true);
    expect(isTerritory('MP')).toBe(true);
  });

  it('returns false for states', () => {
    expect(isTerritory('IL')).toBe(false);
    expect(isTerritory('CA')).toBe(false);
    expect(isTerritory('WY')).toBe(false);
  });
});
