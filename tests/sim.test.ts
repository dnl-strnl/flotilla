import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/engine';
import { makeBot } from '../src/ai';
import { runGame } from '../src/sim/run';
import { wilson95 } from '../src/sim/stats';

describe('simulation harness', () => {
  it('runGame is deterministic for a given seed and seating', () => {
    const mk = () => runGame(makeBot('commander', { samples: 60 }), makeBot('ensign'), PRESETS.FLOTILLA, 99, 0);
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });

  it('bots complete games on every preset without illegal actions (step would throw)', () => {
    for (const preset of ['CLASSIC', 'SALVO', 'FLOTILLA'] as const) {
      for (const name of ['commander', 'lieutenant', 'captain', 'commodore', 'admiral'] as const) {
        const record = runGame(makeBot(name, { samples: 40 }), makeBot('ensign'), PRESETS[preset], 7, 1);
        expect(['A', 'B', 'draw']).toContain(record.winner);
        expect(record.turns).toBeGreaterThan(5);
      }
    }
  });

  it('wilson interval behaves sanely', () => {
    const ci = wilson95(80, 100);
    expect(ci.lo).toBeGreaterThan(0.7);
    expect(ci.hi).toBeLessThan(0.88);
    expect(wilson95(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});
