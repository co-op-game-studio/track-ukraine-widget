/**
 * ULID — 128-bit lexicographically sortable identifier.
 * Crockford-base32, 26 chars: 10 timestamp + 16 randomness.
 * Spec: https://github.com/ulid/spec
 *
 * Traces to FR-49 AC-49.5.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RAND_LEN = 16;
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(now: number): string {
  let n = now;
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = n % ENCODING_LEN;
    out[i] = ENCODING[mod]!;
    n = (n - mod) / ENCODING_LEN;
  }
  return out.join('');
}

function encodeRandom(): string {
  const buf = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < RAND_LEN; i++) {
    out += ENCODING[buf[i]! % ENCODING_LEN];
  }
  return out;
}

export function newUlid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function isUlid(s: unknown): s is string {
  return typeof s === 'string' && ULID_REGEX.test(s);
}
