import { describe, expect, it } from 'vitest';
import {
  DECOY_BASE,
  PASS_ID,
  PRESETS,
  createGame,
  legalActionIds,
  mulberry32,
  observe,
  randomFleet,
  step,
  type GameState,
} from '../src/engine';
import { makeBot, opponentViewOfOurBoard } from '../src/ai';
import { shotsBy } from './helpers';

// Decoy siting models what the OPPONENT believes about our board; assert that
// reconstruction exactly matches the opponent's real recorded intel.
describe('opponent-belief reconstruction (decoy siting)', () => {
  it('exactly reproduces the shots the opponent actually recorded', () => {
    const rng = mulberry32(31337);
    let state: GameState = createGame(
      PRESETS.FLOTILLA,
      [randomFleet(rng), randomFleet(rng)],
      31337,
    );
    const p0 = makeBot('commander', { samples: 60 });
    const p1 = makeBot('admiral', { samples: 60 });

    let guard = 0;
    let checked = 0;
    while (state.phase.kind === 'playing' && guard++ < 4000) {
      const seat = state.activePlayer;
      const bot = seat === 0 ? p0 : p1;
      state = step(state, bot(observe(state, seat), legalActionIds(state), rng), rng).state;

      // Seat 1 (ADMIRAL) reconstructs seat 0's view of seat 1's board.
      const modelled = opponentViewOfOurBoard(observe(state, 1)).myShots;
      const truth = shotsBy(state, 0);
      expect(modelled).toHaveLength(truth.length);
      // Cells and turns must line up exactly…
      expect(modelled.map((s) => s.cell)).toEqual(truth.map((s) => s.cell));
      expect(modelled.map((s) => s.turn)).toEqual(truth.map((s) => s.turn));
      // …and hit-vs-miss must match what the opponent was told, decoy fakes
      // included (a fake HIT is a HIT as far as they know).
      expect(modelled.map((s) => s.result === 'MISS')).toEqual(
        truth.map((s) => s.result === 'MISS'),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('counts a spent decoy as a hit the opponent believes in', () => {
    const rng = mulberry32(5);
    let state: GameState = createGame(
      PRESETS.FLOTILLA,
      [randomFleet(rng), randomFleet(rng)],
      5,
    );
    // P1 places a decoy on a cell no ship occupies, P0 shoots it.
    const occupied = new Set(state.players[1].ships.flatMap((s) => [s.origin]));
    const free = [...Array(100).keys()].find(
      (c) => !occupied.has(c) && legalActionIds(state).length > 0,
    )!;
    state = step(state, { type: 'PASS' }, rng).state; // hand turn to P1
    const decoyCell = legalActionIds(state)
      .filter((id) => id >= DECOY_BASE && id < PASS_ID)
      .map((id) => id - DECOY_BASE)
      .find((c) => c !== free)!;
    state = step(state, { type: 'DECOY', cell: decoyCell }, rng).state;
    while (state.activePlayer !== 0) state = step(state, { type: 'PASS' }, rng).state;
    state = step(state, { type: 'FIRE', cell: decoyCell }, rng).state;

    const modelled = opponentViewOfOurBoard(observe(state, 1)).myShots;
    const atCell = modelled.find((s) => s.cell === decoyCell)!;
    expect(atCell.result).toBe('HIT');
    expect(shotsBy(state, 0).find((s) => s.cell === decoyCell)!.result).toBe('HIT');
    // …while no real ship took damage.
    expect(state.players[1].ships.every((s) => s.hits.every((h) => !h))).toBe(true);
  });
});
