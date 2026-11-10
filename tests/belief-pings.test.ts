import { describe, expect, it } from 'vitest';
import { PRESETS, mulberry32, observe, type Observation } from '../src/engine';
import { buildBelief, type SampleOptions } from '../src/ai/montecarlo';
import { newGame } from './helpers';

// ADMIRAL-like sampling: pings on, heavy evidence floor (stale records barely decay).
const OPTS: SampleOptions = {
  samples: 2000,
  missDecayTurns: 6,
  missFloor: 0.85,
  usePings: true,
  maxAttempts: 12,
};

describe('belief vs stale contact pings (sonar is live-only)', () => {
  // A sweep at 90 read contact off the destroyer at 80,81, which we then sank. The belief
  // must credit the wreck for that contact, not demand a phantom un-hit ship on 90/91.
  it('a contact sweep answered by a since-sunk hull adds no phantom constraint', () => {
    const live = PRESETS.FLOTILLA;
    const base = observe(newGame(live), 0);
    const obs: Observation = {
      ...base,
      turn: 10,
      myShots: [
        { cell: 80, result: 'HIT', turn: 3 },
        { cell: 81, result: 'SUNK', turn: 4, sunkShip: 'destroyer' },
      ],
      myPings: [{ center: 90, cells: [80, 81, 90, 91], contact: true, turn: 2 }],
      enemySunk: ['destroyer'],
      enemyShipsRemaining: 4,
    };

    const withStalePing = buildBelief(obs, OPTS, mulberry32(7));
    const noPing = buildBelief({ ...obs, myPings: [] }, OPTS, mulberry32(7));
    const sum = (heat: Float64Array) => heat[90]! + heat[91]!;
    // Phantom enforcement pins an un-hit ship onto 90/91 in ~half the samples
    // (contact trust 0.6 × stale floor 0.85), inflating this sum by ~0.3.
    expect(Math.abs(sum(withStalePing.heat) - sum(noPing.heat))).toBeLessThan(0.1);
  });

  // Control: the same constraint must still bite when it is NOT stale — a
  // contact sweep over open water with no hits near it should pull probability
  // mass into its region.
  it('a fresh unexplained contact sweep still attracts ship mass', () => {
    const live = PRESETS.FLOTILLA;
    const base = observe(newGame(live), 0);
    const obs: Observation = {
      ...base,
      turn: 5,
      myShots: [],
      myPings: [{ center: 55, cells: [44, 45, 46, 54, 55, 56, 64, 65, 66], turn: 4, contact: true }],
      enemySunk: [],
      enemyShipsRemaining: 5,
    };
    const withPing = buildBelief(obs, OPTS, mulberry32(7));
    const noPing = buildBelief({ ...obs, myPings: [] }, OPTS, mulberry32(7));
    const regionSum = (heat: Float64Array) =>
      [44, 45, 46, 54, 55, 56, 64, 65, 66].reduce((a, c) => a + heat[c]!, 0);
    expect(regionSum(withPing.heat)).toBeGreaterThan(regionSum(noPing.heat) + 0.2);
  });
});

describe('belief vs ECHO occupancy', () => {
  // An ECHO's OCCUPANCY bounds the live ship cells under it to [n - MAX_DECOYS, n].
  it('a fresh occupancy reading sets how much ship mass sits in the block', () => {
    const base = observe(newGame(), 0);
    const block = [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33];
    const mass = (n: number) => {
      const obs: Observation = {
        ...base,
        turn: 5,
        myPings: [{ center: 0, cells: block, contact: n > 0, occupancy: n, turn: 4 }],
      };
      const heat = buildBelief(obs, OPTS, mulberry32(3)).heat;
      return block.reduce((sum, c) => sum + heat[c]!, 0);
    };
    const none = mass(0);
    const six = mass(6);
    expect(none).toBeLessThan(0.3);
    expect(six).toBeGreaterThan(3.5);
    expect(six).toBeLessThan(6.5);
  });
});
