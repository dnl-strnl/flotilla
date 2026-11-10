import { describe, expect, it } from 'vitest';
import {
  AP_COST,
  PING_ESCALATED_COST,
  PRESETS,
  createGame,
  encodeAction,
  legalActionIds,
  mulberry32,
  observe,
  pingCostFor,
  step,
  type Action,
  type GameState,
} from '../src/engine';
import { TEST_FLEET } from './helpers';

// pingEscalates: the first sweep of a turn is the listed price, every later one in the same
// turn costs PING_ESCALATED_COST — and only ever in MELEE.

const ON = { ...PRESETS.FLOTILLA, pingEscalates: true };
const rng = mulberry32(5);

function game(config = ON, seats = 3, seed = 7): GameState {
  const fleets = Array.from({ length: seats }, () => structuredClone(TEST_FLEET));
  return createGame(config, fleets as [typeof TEST_FLEET, typeof TEST_FLEET], seed);
}

const play = (state: GameState, actions: Action[]): GameState =>
  actions.reduce((s, a) => step(s, a, rng).state, state);

const ping = (center: number, at?: number): Action => ({ type: 'PING', center, ...(at ? { at } : {}) });

describe('pingEscalates', () => {
  it('stays off in every preset', () => {
    for (const preset of Object.values(PRESETS)) expect(preset.pingEscalates).toBe(false);
  });

  it('charges 1 then 2 within one MELEE turn', () => {
    const start = game();
    expect(start.budget).toBe(5);
    const after1 = play(start, [ping(0)]);
    expect(after1.ap).toBe(5 - AP_COST.PING);
    expect(after1.pingsThisTurn).toBe(1);
    const after2 = play(after1, [ping(55)]);
    expect(after2.ap).toBe(5 - AP_COST.PING - PING_ESCALATED_COST);
    expect(after2.pingsThisTurn).toBe(2);
  });

  it('counts per TURN, not per enemy board — the second seat swept pays the surcharge', () => {
    const after = play(game(), [ping(0, 1), ping(0, 2)]);
    expect(after.ap).toBe(5 - AP_COST.PING - PING_ESCALATED_COST);
  });

  it('resets the price at every handoff', () => {
    const next = play(game(), [ping(0), ping(55), { type: 'PASS' }]);
    expect(next.pingsThisTurn).toBe(0);
    expect(observe(next, next.activePlayer).pingCost).toBe(AP_COST.PING);
  });

  it('under the flat price a leftover point still buys sonar', () => {
    // 5 AP, a sweep and a decoy, 1 left. Escalated, nothing is affordable and the turn
    // simply ends (next test); flat, that point keeps the turn open for one more sweep.
    const flat = play(game(PRESETS.FLOTILLA), [ping(0), { type: 'DECOY', cell: 55 }]);
    expect(flat.ap).toBe(1);
    expect(legalActionIds(flat)).toContain(encodeAction(ping(33)));
  });

  it('forfeits that leftover point — the turn auto-ends with 1 AP unspent', () => {
    const start = game();
    const after = play(start, [ping(0), { type: 'DECOY', cell: 55 }]);
    expect(after.activePlayer).not.toBe(start.activePlayer);
    expect(after.pingsThisTurn).toBe(0);
  });

  it('is a no-op in a duel, flag or no flag', () => {
    for (let pings = 0; pings < 4; pings++) {
      expect(pingCostFor(ON, 2, pings)).toBe(AP_COST.PING);
    }
    const duel = createGame(ON, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], 7);
    const after = play(duel, [ping(0), ping(55)]);
    expect(after.ap).toBe(duel.budget - 2 * AP_COST.PING);
  });

  it('quotes the next sweep through the observation', () => {
    const start = game();
    expect(observe(start, start.activePlayer).pingCost).toBe(AP_COST.PING);
    const after = play(start, [ping(0)]);
    expect(observe(after, after.activePlayer).pingCost).toBe(PING_ESCALATED_COST);
    // Not my turn: no price quoted, same as ap/budget.
    expect(observe(after, (after.activePlayer + 1) % 3).pingCost).toBe(0);
  });
});
