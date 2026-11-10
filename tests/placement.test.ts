import { describe, expect, it } from 'vitest';
import { FLEET, cellsFor, mulberry32, randomFleet, validateFleet } from '../src/engine';
import { TEST_FLEET } from './helpers';

describe('placement validation', () => {
  it('accepts the canonical test fleet', () => {
    expect(validateFleet(TEST_FLEET)).toEqual([]);
  });

  it('rejects a fleet in the wrong canonical order', () => {
    const swapped = structuredClone(TEST_FLEET);
    const a = swapped[0]!;
    swapped[0] = swapped[1]!;
    swapped[1] = a;
    expect(validateFleet(swapped)).toEqual([{ shipIndex: -1, reason: 'wrong-fleet' }]);
  });

  it('rejects out-of-bounds placements', () => {
    const fleet = structuredClone(TEST_FLEET);
    fleet[0] = { kind: 'carrier', origin: 7, orient: 'H' }; // cols 8..12 → off board
    expect(validateFleet(fleet)).toEqual([{ shipIndex: 0, reason: 'out-of-bounds' }]);
  });

  it('rejects overlaps but allows touching', () => {
    const overlapping = structuredClone(TEST_FLEET);
    overlapping[1] = { kind: 'battleship', origin: 2, orient: 'V' }; // crosses carrier at cell 2
    expect(validateFleet(overlapping)).toEqual([{ shipIndex: 1, reason: 'overlap' }]);

    const touching = structuredClone(TEST_FLEET);
    touching[1] = { kind: 'battleship', origin: 10, orient: 'H' }; // directly under carrier
    expect(validateFleet(touching)).toEqual([]);
  });

  it('randomFleet always produces a valid fleet', () => {
    for (let seed = 0; seed < 50; seed++) {
      const fleet = randomFleet(mulberry32(seed));
      expect(validateFleet(fleet)).toEqual([]);
      expect(fleet.map((p) => p.kind)).toEqual(FLEET.map((f) => f.kind));
    }
  });

  it('randomFleet is deterministic per seed', () => {
    expect(randomFleet(mulberry32(7))).toEqual(randomFleet(mulberry32(7)));
  });

  it('cellsFor matches orientation math', () => {
    expect(cellsFor(33, 'V', 3)).toEqual([33, 43, 53]);
  });
});
