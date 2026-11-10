import { describe, expect, it } from 'vitest';
import {
  AP_CAP,
  AP_FLOOR,
  FLEET,
  PRESETS,
  budgetFor,
  legalActions,
  legalActionIds,
} from '../src/engine';
import { doStep, newGame, pass, run, shot } from './helpers';

describe('CLASSIC turn flow (flat 2-AP budget = one shot)', () => {
  it('offers only shots and pass', () => {
    const state = newGame(PRESETS.CLASSIC);
    const types = new Set(legalActions(state).map((a) => a.type));
    expect(types).toEqual(new Set(['FIRE', 'PASS']));
    expect(legalActionIds(state)).toHaveLength(101);
  });

  it('auto-ends the turn after one shot', () => {
    const state = newGame(PRESETS.CLASSIC);
    const { state: next, events } = doStep(state, shot(99));
    expect(events.map((e) => e.type)).toEqual(['fire', 'turnEnded', 'turnStarted']);
    expect(events.find((e) => e.type === 'turnEnded')).toMatchObject({ reason: 'exhausted' });
    expect(next.activePlayer).toBe(1);
    expect(next.turn).toBe(2);
    expect(next.budget).toBe(2);
  });
});

describe('SPRAY AP budget', () => {
  it('starts at 5 AP (5 ships) and allows two shots', () => {
    const state = newGame(PRESETS.SALVO);
    expect(state.budget).toBe(5);
    const r1 = doStep(state, shot(80));
    expect(r1.state.ap).toBe(3);
    const r2 = doStep(r1.state, shot(81)); // sinks destroyer → 1 AP left, nothing costs ≤1 in SPRAY
    expect(r2.events.find((e) => e.type === 'turnEnded')).toMatchObject({ reason: 'exhausted' });
    expect(r2.state.activePlayer).toBe(1);
  });

  it('a mid-turn sink never changes the attacker’s current AP, only the victim’s next budget', () => {
    const state = newGame(PRESETS.SALVO);
    const r1 = doStep(state, shot(80));
    const r2 = doStep(r1.state, shot(81)); // destroyer sunk mid-turn
    const started = r2.events.find((e) => e.type === 'turnStarted');
    expect(started).toMatchObject({ player: 1, budget: 4 }); // victim down to 4 ships
  });

  it('budget decays as ships sink and PASS forfeits remaining AP (no banking)', () => {
    const state = newGame(PRESETS.SALVO);
    // P0 sinks destroyer (80,81), P1 passes; P1's budgets observed via turnStarted.
    const r = run(state, [shot(80), shot(81), pass, shot(60), shot(61)]);
    // P0's second turn: still 5 ships → budget 5; after shots 60,61 ap=1 → exhausted.
    expect(r.state.turn).toBe(4);
    expect(r.state.activePlayer).toBe(1);
    expect(r.state.budget).toBe(4);
    // PASS forfeited P1's whole 4-AP budget; nothing carried over.
    const p1Turns = r.events.filter(
      (e) => e.type === 'turnStarted' && e.player === 1,
    ) as Array<{ budget: number }>;
    expect(p1Turns.map((t) => t.budget)).toEqual([4, 4]);
  });
});

describe('turn flow', () => {
  it('CLASSIC flips the turn the moment the shot is spent', () => {
    const r = doStep(newGame(PRESETS.CLASSIC), shot(99));
    expect(r.events.map((e) => e.type)).toEqual(['fire', 'turnEnded', 'turnStarted']);
    expect(r.state.activePlayer).toBe(1);
  });

  it('a PASS with AP still affordable reports a voluntary "pass"', () => {
    const r = doStep(newGame(PRESETS.SALVO), pass);
    expect(r.events.find((e) => e.type === 'turnEnded')).toMatchObject({ reason: 'pass' });
  });

  it('a spent turn ends itself, reported as "exhausted"', () => {
    const r = run(newGame(PRESETS.SALVO), [shot(80), shot(81)]);
    expect(r.events.find((e) => e.type === 'turnEnded')).toMatchObject({ reason: 'exhausted' });
    expect(r.state.activePlayer).toBe(1);
  });
});

describe('AP floor — a surviving fleet can always return fire', () => {
  // Sink P1 down to `leave` ships; P1 only ever passes so its ships stay put.
  const grindDownTo = (leave: number) => {
    let s = newGame(PRESETS.FLOTILLA);
    const kills = [
      [80, 81],            // destroyer
      [60, 61, 62],        // submarine
      [40, 41, 42],        // cruiser
      [20, 21, 22, 23],    // battleship
    ].slice(0, 5 - leave).flat();
    for (const cell of kills) {
      while (s.activePlayer !== 0 || s.ap < 2) s = run(s, [pass]).state;
      s = run(s, [shot(cell)]).state;
    }
    while (s.activePlayer !== 1) s = run(s, [pass]).state;
    return s;
  };

  it('a 1-ship player still gets 2 AP and can shoot', () => {
    const s = grindDownTo(1);
    expect(s.players[1].ships.filter((ship) => !ship.sunk)).toHaveLength(1);
    expect(s.budget).toBe(AP_FLOOR);
    const types = new Set(legalActions(s).map((a) => a.type));
    expect(types.has('FIRE')).toBe(true);
    // And the shot actually resolves rather than being masked out.
    const r = run(s, [shot(0)]);
    expect(r.state.players[0].shotsReceived.map((x) => x.cell)).toContain(0);
  });

  it('leaves the tempo-decay curve above the floor untouched', () => {
    // 5 → 4 → 3 → 2 ships all map to their own ship count; only 1 is clamped.
    for (const [ships, expected] of [[4, 4], [3, 3], [2, 2], [1, AP_FLOOR]] as const) {
      expect(grindDownTo(ships).budget).toBe(expected);
    }
  });

  it('CLASSIC is unaffected — still exactly one shot per turn', () => {
    const r = doStep(newGame(PRESETS.CLASSIC), shot(99));
    expect(r.state.budget).toBe(2);
    expect(r.state.activePlayer).toBe(1);
  });
});

describe('meleeFullAp — a three-way game plays at a flat AP_CAP', () => {
  // A fleet with `unsunk` ships still floating, which is all budgetFor reads.
  const fleetOf = (unsunk: number) => ({
    ships: FLEET.map((f, i) => ({
      kind: f.kind,
      length: f.length,
      origin: 0,
      orient: 'H' as const,
      hits: [],
      sunk: i >= unsunk,
    })),
    decoys: [],
    decoysPlaced: 0,
    toolLastUsed: {},
    pings: [],
    wakes: [],
    wakeTrail: [],
    shotsReceived: [],
  });
  it('plays a three-way game at a flat AP_CAP whatever has been lost', () => {
    // MELEE hands every fleet AP_CAP while three are up, so losses cost no tempo.
    for (let unsunk = 1; unsunk <= 5; unsunk++) {
      expect(budgetFor(PRESETS.FLOTILLA, fleetOf(unsunk), 3)).toBe(AP_CAP);
    }
    // CLASSIC and SALVO MELEE keep the ships-afloat curve.
    expect(budgetFor(PRESETS.SALVO, fleetOf(2), 3)).toBe(2);
    // Duels keep the floor they have always had.
    expect(budgetFor(PRESETS.FLOTILLA, fleetOf(2), 2)).toBe(AP_FLOOR);
  });
});

describe('FLOTILLA keeps the turn alive while 1-AP actions remain', () => {
  it('after two shots, pings are still offered (MOVE at 2 AP is not)', () => {
    const state = newGame(PRESETS.FLOTILLA);
    const r = run(state, [shot(90), shot(91)]);
    expect(r.state.activePlayer).toBe(0); // turn NOT auto-ended
    expect(r.state.ap).toBe(1);
    const types = new Set(legalActions(r.state).map((a) => a.type));
    expect(types).toEqual(new Set(['PING', 'PASS']));
  });
});
