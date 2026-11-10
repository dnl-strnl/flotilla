import { describe, expect, it } from 'vitest';
import { MAX_TURNS, PRESETS, legalActionIds, shipCells, type GameState } from '../src/engine';
import { doStep, newGame, pass, run, shot, shotsBy, sunkBy } from './helpers';

describe('sinking and victory', () => {
  it('announces SUNK with ship identity and ends the game when the last ship dies', () => {
    let state: GameState = newGame(PRESETS.FLOTILLA);
    const targets = state.players[1].ships.flatMap((s) => shipCells(s));
    while (state.phase.kind === 'playing') {
      if (state.activePlayer === 0 && state.ap >= 2 && targets.length > 0) {
        state = doStep(state, shot(targets.shift()!)).state;
      } else {
        state = doStep(state, pass).state;
      }
    }
    expect(state.phase).toEqual({ kind: 'won', winner: 0, eliminated: 1 });
    expect(sunkBy(state, 0)).toEqual([
      'carrier',
      'battleship',
      'cruiser',
      'submarine',
      'destroyer',
    ]);
    const sunkRecords = shotsBy(state, 0).filter((s) => s.result === 'SUNK');
    expect(sunkRecords.map((s) => s.sunkShip)).toEqual(sunkBy(state, 0));
    // Finished game: no legal actions, and step() refuses to run.
    expect(legalActionIds(state)).toEqual([]);
    expect(() => doStep(state, pass)).toThrow();
  });

  it('a sunk wreck stays on the board where it went down', () => {
    // Sonar is live-only, so it can't probe a wreck; read the board directly.
    const r = run(newGame(), [shot(80), shot(81), pass, pass]);
    expect(r.state.players[1].ships[4]).toMatchObject({ origin: 80, sunk: true, hits: [true, true] });
  });

  it('reduces the loser’s AP budget immediately after each sink', () => {
    const r = run(newGame(PRESETS.FLOTILLA), [shot(80), shot(81), pass]);
    const started = r.events.filter((e) => e.type === 'turnStarted').pop();
    expect(started).toMatchObject({ player: 1, budget: 4 });
  });
});

describe('MAX_TURNS cap', () => {
  it('ends in a draw with exactly one gameOver event', () => {
    let state: GameState = newGame(PRESETS.FLOTILLA);
    const gameOvers: unknown[] = [];
    while (state.phase.kind === 'playing') {
      const r = doStep(state, pass);
      state = r.state;
      gameOvers.push(...r.events.filter((e) => e.type === 'gameOver'));
    }
    expect(state.phase).toEqual({ kind: 'draw' });
    expect(state.turn).toBe(MAX_TURNS);
    expect(gameOvers).toEqual([{ type: 'gameOver', turn: MAX_TURNS, result: 'draw' }]);
  });
});
