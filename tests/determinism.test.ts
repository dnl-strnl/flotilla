import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  createGame,
  decodeAction,
  exportReplay,
  legalActionIds,
  mulberry32,
  randomFleet,
  rngPick,
  runReplay,
  step,
  type Action,
  type Event,
  type GameState,
} from '../src/engine';

// Play a full game with both sides choosing uniformly random legal actions.
function playRandomGame(seed: number): {
  states: GameState[];
  actions: Action[];
  events: Event[];
  initial: GameState;
} {
  const rng = mulberry32(seed);
  const placements: [ReturnType<typeof randomFleet>, ReturnType<typeof randomFleet>] = [
    randomFleet(rng),
    randomFleet(rng),
  ];
  const initial = createGame(PRESETS.FLOTILLA, placements, seed);
  let state = initial;
  const states: GameState[] = [];
  const actions: Action[] = [];
  const events: Event[] = [];
  let guard = 0;
  while (state.phase.kind === 'playing' && guard++ < 5000) {
    const action = decodeAction(rngPick(rng, legalActionIds(state)));
    const r = step(state, action, rng);
    state = r.state;
    states.push(state);
    actions.push(action);
    events.push(...r.events);
  }
  return { states, actions, events, initial };
}

describe('determinism', () => {
  it('same seed + same action list → identical state trajectories and events', () => {
    const a = playRandomGame(2024);
    const b = playRandomGame(2024);
    expect(JSON.stringify(a.states)).toBe(JSON.stringify(b.states));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('step() never mutates its input state', () => {
    const rng = mulberry32(5);
    const placements: [ReturnType<typeof randomFleet>, ReturnType<typeof randomFleet>] = [
      randomFleet(rng),
      randomFleet(rng),
    ];
    const state = createGame(PRESETS.FLOTILLA, placements, 5);
    const frozen = JSON.stringify(state);
    step(state, { type: 'FIRE', cell: 33 }, rng);
    step(state, { type: 'PASS' }, rng);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('replay round-trip reproduces the exact final state and event log', () => {
    const game = playRandomGame(77);
    const replay = exportReplay(
      PRESETS.FLOTILLA,
      77,
      0,
      [
        game.initial.players[0].ships.map((s) => ({ kind: s.kind, origin: s.origin, orient: s.orient })),
        game.initial.players[1].ships.map((s) => ({ kind: s.kind, origin: s.origin, orient: s.orient })),
      ],
      game.actions,
      game.events,
    );
    const rerun = runReplay(replay);
    expect(JSON.stringify(rerun.state)).toBe(JSON.stringify(game.states.at(-1)));
    expect(JSON.stringify(rerun.events)).toBe(JSON.stringify(game.events));
  });

  it('replays survive a JSON serialization round-trip', () => {
    const game = playRandomGame(31);
    const replay = exportReplay(
      PRESETS.FLOTILLA,
      31,
      0,
      [
        game.initial.players[0].ships.map((s) => ({ kind: s.kind, origin: s.origin, orient: s.orient })),
        game.initial.players[1].ships.map((s) => ({ kind: s.kind, origin: s.origin, orient: s.orient })),
      ],
      game.actions,
      game.events,
    );
    const rerun = runReplay(JSON.parse(JSON.stringify(replay)));
    expect(JSON.stringify(rerun.state)).toBe(JSON.stringify(game.states.at(-1)));
  });
});
