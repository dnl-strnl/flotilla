import type { RNG } from './types';

// mulberry32 — small, fast, good-enough seeded PRNG.
export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer in [0, n).
export function rngInt(rng: RNG, n: number): number {
  return Math.floor(rng() * n);
}

export function rngPick<T>(rng: RNG, items: readonly T[]): T {
  if (items.length === 0) throw new Error('rngPick on empty array');
  return items[rngInt(rng, items.length)] as T;
}

// Fisher–Yates; returns a new array.
export function rngShuffle<T>(rng: RNG, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
