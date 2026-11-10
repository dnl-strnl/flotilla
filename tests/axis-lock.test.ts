import { describe, expect, it } from 'vitest';
import { PRESETS, type Observation, type ShotRecord } from '../src/engine';
import { hitRuns, pickFinishingShot, sunkHitCells } from '../src/ai/commodore';
import { buildBelief } from '../src/ai/montecarlo';
import { mulberry32 } from '../src/engine';

function obsWith(shots: ShotRecord[], extra: Partial<Observation> = {}): Observation {
  return {
    config: PRESETS.FLOTILLA,
    me: 0,
    turn: 30,
    ap: 4,
    budget: 4,
    movedShips: [],
    myShips: [],
    myDecoys: [],
    myDecoysLeft: 2,
    shotsAgainstMe: [],
    myShots: shots,
    myPings: [],
    enemyWakes: [],
    enemySunk: [],
    enemyShipsRemaining: 5,
    ...extra,
  } as Observation;
}

const hit = (cell: number, turn = 10): ShotRecord => ({ cell, result: 'HIT', turn });
const miss = (cell: number, turn = 10): ShotRecord => ({ cell, result: 'MISS', turn });

describe('axis-locked finishing', () => {
  it('finds maximal collinear runs and their two extension cells', () => {
    const runs = hitRuns([44, 45, 46, 80]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cells).toEqual([44, 45, 46]);
    expect(runs[0]!.ends.sort((a, b) => a - b)).toEqual([43, 47]);
  });

  it('clips extensions at the board edge', () => {
    const runs = hitRuns([0, 1]);
    expect(runs[0]!.ends).toEqual([2]);
  });

  it('shoots along the axis of an unsunk run, not around it', () => {
    const shots = [hit(44), hit(45), miss(35), miss(55)];
    const obs = obsWith(shots);
    const rng = mulberry32(5);
    const belief = buildBelief(obs, { samples: 200, missDecayTurns: null, usePings: false, maxAttempts: 12 }, rng);
    const legal = new Set<number>();
    for (let c = 0; c < 100; c++) legal.add(25 + c); // FIRE_BASE..+99
    const action = pickFinishingShot(obs, belief, legal, { unresolvedHitProb: 0.5, axisLock: true }, rng);
    expect(action?.type).toBe('FIRE');
    expect([43, 46]).toContain((action as { cell: number }).cell);
  });

  it('keeps the lock when the heatmap has lost faith in the wound', () => {
    // No sunk ship explains 44/45, so the rules still call them live even
    // though a decoy-poisoned belief may give them ~no heat.
    const obs = obsWith([hit(44), hit(45)]);
    const rng = mulberry32(7);
    const flat = { heat: new Float64Array(100), samples: [] };
    const legal = new Set<number>();
    for (let c = 0; c < 100; c++) legal.add(25 + c);
    const action = pickFinishingShot(obs, flat, legal, { unresolvedHitProb: 0.5, axisLock: true }, rng);
    expect([43, 46]).toContain((action as { cell: number }).cell);
  });

  it('retires a run that a reported SUNK exactly explains', () => {
    const shots: ShotRecord[] = [
      hit(44),
      { cell: 45, result: 'SUNK', turn: 11, sunkShip: 'destroyer' },
    ];
    expect([...sunkHitCells(obsWith(shots))].sort((a, b) => a - b)).toEqual([44, 45]);
    const rng = mulberry32(9);
    const flat = { heat: new Float64Array(100), samples: [] };
    const legal = new Set<number>();
    for (let c = 0; c < 100; c++) legal.add(25 + c);
    expect(pickFinishingShot(obsWith(shots), flat, legal, { unresolvedHitProb: 0.5, axisLock: true }, rng)).toBeNull();
  });

  it('attributes nothing when the run is longer than the sunk ship', () => {
    // destroyer (2) sunk inside a run of three: the split is ambiguous, so the
    // third cell must stay live rather than being wrongly retired.
    const shots: ShotRecord[] = [
      hit(44),
      hit(46),
      { cell: 45, result: 'SUNK', turn: 12, sunkShip: 'destroyer' },
    ];
    expect(sunkHitCells(obsWith(shots)).size).toBe(0);
  });
});
