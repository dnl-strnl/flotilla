import { describe, expect, it } from 'vitest';
import type { Event } from '../src/engine';
import { CPU_JITTER, CPU_THINK, cpuDelayMs } from '../src/ui/pacing';

const shot = (reported: 'HIT' | 'MISS' | 'SUNK'): Event => ({
  type: 'fire', turn: 1, by: 1, target: 0, cell: 44, reported,
});

// rand stub yielding a fixed sequence (last value repeats).
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

// rand stub that never triggers the think-gate (2nd draw ≥ chance).
const noThink = (r: number) => seq(r, 0.99);

describe('cpu pacing', () => {
  it('jitters every gap within a bounded band', () => {
    const gaps = [0, 0.25, 0.5, 0.75, 0.999].map((r) => cpuDelayMs(400, [], noThink(r)));
    expect(new Set(gaps).size).toBe(gaps.length);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(400 * CPU_JITTER.min);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(400 * CPU_JITTER.max);
  });

  it('occasionally stretches a gap well past the jitter band', () => {
    const hesitant = cpuDelayMs(400, [], seq(0.5, CPU_THINK.chance / 2, 0.5));
    const brisk = cpuDelayMs(400, [], seq(0.5, 0.99));
    expect(brisk).toBeLessThanOrEqual(400 * CPU_JITTER.max);
    expect(hesitant).toBeGreaterThan(400 * CPU_JITTER.max);
  });

  it('waits longer after an action whose result needs to land', () => {
    const half = () => 0.5;
    const quiet = cpuDelayMs(400, [{ type: 'move', turn: 1, player: 1, ship: 0, dir: 'N', from: 44, to: 34 }], half);
    expect(cpuDelayMs(400, [shot('MISS')], half)).toBeGreaterThan(quiet);
    expect(cpuDelayMs(400, [shot('SUNK')], half)).toBeGreaterThan(cpuDelayMs(400, [shot('MISS')], half));
  });

  it('pauses at the turn boundary (turnStarted is the tail event after a flip)', () => {
    const half = () => 0.5;
    const quiet = cpuDelayMs(400, [{ type: 'move', turn: 1, player: 1, ship: 0, dir: 'N', from: 44, to: 34 }], half);
    const flip: Event[] = [
      { type: 'turnEnded', turn: 1, player: 0, reason: 'exhausted' },
      { type: 'turnStarted', turn: 2, player: 1, budget: 5 },
    ];
    expect(cpuDelayMs(400, flip, half)).toBeGreaterThan(quiet + 400);
  });

  it('pauses longer still when the flip hands off from a human turn', () => {
    const half = () => 0.5;
    const flip: Event[] = [
      { type: 'turnEnded', turn: 1, player: 0, reason: 'exhausted' },
      { type: 'turnStarted', turn: 2, player: 1, budget: 5 },
    ];
    expect(cpuDelayMs(400, flip, half, true)).toBeGreaterThan(cpuDelayMs(400, flip, half));
  });

  it('keeps the shape but not the full pause when spectating fast', () => {
    const half = () => 0.5;
    expect(cpuDelayMs(60, [shot('SUNK')], half)).toBeLessThan(cpuDelayMs(400, [shot('SUNK')], half) / 2);
  });

  it('never stalls, whatever the inputs', () => {
    expect(cpuDelayMs(0, [], () => 0)).toBeGreaterThanOrEqual(80);
  });
});
