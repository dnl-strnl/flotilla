import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, type PingRecord } from '../src/engine';
import { PING_DECAY_STEPS, blendPingWash, enemyBoardCells, pingHue, truthBoardWithSonar } from '../src/ui/viewmodels';
import { TEST_FLEET, newGame, ping as pingAction, run, shot } from './helpers';

const ping = (turn: number, contact = true): PingRecord => ({
  center: 44, cells: [44], contact, turn,
});

const hueOf = (wash: { color: string }): number => Number(/hsl\((\d+)/.exec(wash.color)![1]);

describe('ping hue decay', () => {
  it('walks red → blue over the decay window', () => {
    expect(pingHue(0)).toBe(0);
    expect(pingHue(PING_DECAY_STEPS - 1)).toBe(220);
    const hues = Array.from({ length: PING_DECAY_STEPS }, (_, age) => pingHue(age));
    for (let i = 1; i < hues.length; i++) expect(hues[i]!).toBeGreaterThan(hues[i - 1]!);
  });

  it('clamps: never warmer than fresh red, never colder than blue', () => {
    expect(pingHue(-3)).toBe(0);
    expect(pingHue(PING_DECAY_STEPS + 25)).toBe(220);
  });
});

describe('ping wash blending', () => {
  it('a lone ping keeps its own age hue', () => {
    expect(hueOf(blendPingWash([ping(2)], 7))).toBe(pingHue(5));
  });

  it('overlapping fresh and stale intel blends between their hues, pulled warm', () => {
    const fresh = ping(10);
    const stale = ping(1);
    const blended = hueOf(blendPingWash([stale, fresh], 10));
    expect(blended).toBeGreaterThan(pingHue(0));
    expect(blended).toBeLessThan(pingHue(9));
    // fresh intel carries more weight, so the blend sits warm of the midpoint
    expect(blended).toBeLessThan((pingHue(0) + pingHue(9)) / 2);
  });

  it('stacked pings read denser than either alone, within the cap', () => {
    const solo = blendPingWash([ping(9)], 10).opacity;
    const stacked = blendPingWash([ping(5), ping(9)], 10).opacity;
    expect(stacked).toBeGreaterThan(solo);
    expect(stacked).toBeLessThanOrEqual(0.65);
  });
});

describe('ping hue toggle', () => {
  const obs = { turn: 8, myPings: [ping(3)], myShots: [], enemyWakes: [] };

  it('on: the wash carries an age hue', () => {
    const cell = enemyBoardCells(obs, null, true)[44]!;
    expect(cell.pingColor).toBe(`hsl(${pingHue(5)} 85% 55%)`);
  });

  it('off: classic flat amber wash (no color override, old fade curve)', () => {
    const cell = enemyBoardCells(obs, null, false)[44]!;
    expect(cell.pingColor).toBeUndefined();
    expect(cell.pingOpacity).toBeCloseTo((1 - 5 / 8) * 0.55);
  });

  it('center is a quiet triangle glyph: up for contact, down for empty scan', () => {
    expect(enemyBoardCells(obs, null, true)[44]!.glyph).toBe('▲');
    const empty = { turn: 8, myPings: [ping(3, false)], myShots: [], enemyWakes: [] };
    expect(enemyBoardCells(empty, null, true)[44]!.glyph).toBe('▽');
  });
});

describe('truth board sonar overlay (replay & observation deck)', () => {
  // Real engine state: P0 hits the cruiser's head (cell 40), then pings over it.
  const { state } = run(newGame(), [shot(40), pingAction(40)]);

  it("the opponent's wash lands on the seat's truth board, never their own", () => {
    const board1 = truthBoardWithSonar(state, 1, true);
    expect(board1[41]!.pingOpacity).toBeGreaterThan(0);
    const board0 = truthBoardWithSonar(state, 0, true);
    expect(board0.every((c) => c.pingOpacity === undefined)).toBe(true);
  });

  it('truth outranks intel: a damage ✕ keeps its glyph under a ping center', () => {
    const cell = truthBoardWithSonar(state, 1, true)[40]!;
    expect(cell.glyph).toBe('✕');
    expect(cell.pingOpacity).toBeGreaterThan(0);
    expect(cell.tag).toBe('T1');
  });

  it('an empty-water center gets the live ▽ marker and the fresh-red hue', () => {
    const swept = run(newGame(), [pingAction(44)]).state;
    const cell = truthBoardWithSonar(swept, 1, true)[44]!;
    expect(cell.glyph).toBe('▽');
    expect(cell.classes).toContain('ping-center');
    expect(cell.pingColor).toBe(`hsl(${pingHue(0)} 85% 55%)`);
  });

  it('hues off: classic flat wash, no color override', () => {
    const cell = truthBoardWithSonar(state, 1, false)[41]!;
    expect(cell.pingColor).toBeUndefined();
    expect(cell.pingOpacity).toBeGreaterThan(0);
  });
});

describe('public ECHO on a truth board', () => {
  const fleet = () => structuredClone(TEST_FLEET);
  const table = () => createGame(PRESETS.FLOTILLA, [fleet(), fleet(), fleet()], 7);
  const sweep: PingRecord = { center: 55, cells: [55, 56], contact: true, turn: 1, target: 0 };
  const washAt55 = (t: ReturnType<typeof table>) =>
    truthBoardWithSonar({ ...t, turn: 5 }, 0, true)[55]!;

  it('washes once however many seats filed it, and still stacks real sweeps', () => {
    const t = table();
    t.players[1]!.pings.push({ ...sweep });
    const solo = washAt55(t);
    // Seat 2 overheard the same ECHO and filed its own copy. One sweep, one answer — the
    // wash must not darken just because the table is bigger.
    t.players[2]!.pings.push({ ...sweep });
    const shared = washAt55(t);
    expect(shared.pingOpacity).toBe(solo.pingOpacity);
    expect(shared.pingColor).toBe(solo.pingColor);
    // A genuinely separate sweep of the same water is two answers, and does stack.
    t.players[2]!.pings.push({ ...sweep, turn: 2 });
    expect(washAt55(t).pingOpacity!).toBeGreaterThan(solo.pingOpacity!);
  });
});

describe('wake markers (sonar-dredged intel on the targeting grid)', () => {
  const base = { myPings: [], myShots: [] };

  it('a shot marker on the same cell keeps its glyph (resolved beats trail)', () => {
    const obs = {
      ...base,
      turn: 5,
      myShots: [{ cell: 10, result: 'MISS' as const, turn: 5 }],
      enemyWakes: [{ cells: [10], turn: 4 }],
    };
    const view = enemyBoardCells(obs, null)[10]!;
    expect(view.glyph).toBe('·');
    expect(view.classes).toContain('wake-mark');
    expect(view.classes).toContain('fire-miss');
  });

  it('a hit on a ping center sheds the center glyph styling (no odd-sized ✕)', () => {
    const obs = {
      ...base,
      turn: 3,
      myPings: [ping(1)],
      myShots: [{ cell: 44, result: 'HIT' as const, turn: 2 }],
      enemyWakes: [],
    };
    const view = enemyBoardCells(obs, null)[44]!;
    expect(view.glyph).toBe('✕');
    expect(view.tag).toBe('T1');
    expect(view.classes).toBe('fire-hit');
  });

  it('a dredged mark lives only through the turn it was swept in', () => {
    // Enemy moved turn 4; I dredged on my turn 5 — mark shows while I spend
    // the rest of that turn's AP…
    const during = enemyBoardCells(
      { ...base, turn: 5, enemyWakes: [{ cells: [10], turn: 4 }] },
      null,
    );
    expect(during[10]!.glyph).toBe('≈');
    expect(during[10]!.classes).not.toContain('wake-stale');
    // …and is gone the moment the opponent's turn starts (turn 6).
    const after = enemyBoardCells(
      { ...base, turn: 6, enemyWakes: [{ cells: [10], turn: 4 }] },
      null,
    );
    expect(after[10]!.glyph).toBeUndefined();
    expect(after[10]!.classes ?? '').not.toContain('wake-mark');
  });
});
