import { describe, expect, it } from 'vitest';
import {
  AP_COST,
  PRESETS,
  createGame,
  isDead,
  mulberry32,
  shipCells,
  step,
  type AtLeastTwo,
  type GameState,
  type ShipPlacement,
} from '../src/engine';
import { applyEngineAction, initialState, type AppState, type Session } from '../src/ui/state';
import { beatsForEvents } from '../src/ui/sfx/cues';
import { redactEventsFor } from '../src/engine';
import { TEST_FLEET } from './helpers';

// MELEE plays on past the first kill, but the human whose fleet went down is out of
// it. These cover the hand-off: the reducer leaves the game screen, and the one sound the
// engine will never announce for them still plays.

const fleets = () =>
  [
    structuredClone(TEST_FLEET),
    structuredClone(TEST_FLEET),
    structuredClone(TEST_FLEET),
  ] as AtLeastTwo<ShipPlacement[]>;

function meleeApp(state: GameState): AppState {
  const session: Session = {
    setup: { ...initialState.setup, mode: 'open', preset: 'FLOTILLA' },
    config: PRESETS.FLOTILLA,
    placements: fleets(),
    state,
    actions: [],
    events: [],
    // The human always holds seat 0.
    bots: [null, 'admiral', 'commander'],
    concealed: false,
  };
  return {
    ...initialState,
    session,
    screen: { kind: 'game', perspective: 0, tool: 'FIRE', selectedShip: null },
  };
}

// Seat 1 shells the human (seat 0) down to one cell short of dead, leaving the killing
// shot for the test to fire through the reducer.
function onLastHull(): { state: GameState; lastCell: number } {
  const rng = mulberry32(21);
  let s = createGame(PRESETS.FLOTILLA, fleets(), 4);
  const hull = s.players[0]!.ships.flatMap(shipCells);
  const lastCell = hull.pop()!;
  let guard = 0;
  while (hull.length > 0 && guard++ < 900) {
    if (s.activePlayer === 1 && s.ap >= AP_COST.FIRE) {
      // Seat 0 is two seats along from seat 1 in a three-way rotation.
      s = step(s, { type: 'FIRE', cell: hull.shift()!, at: 2 }, rng).state;
    } else {
      s = step(s, { type: 'PASS' }, rng).state;
    }
  }
  while (s.activePlayer !== 1 || s.ap < AP_COST.FIRE) s = step(s, { type: 'PASS' }, rng).state;
  return { state: s, lastCell };
}

describe('the human going down in MELEE', () => {
  it('leaves the game screen for the end screen while the survivors fight on', () => {
    const { state, lastCell } = onLastHull();
    const app = meleeApp(state);
    expect(app.screen.kind).toBe('game');

    const next = applyEngineAction(app, { type: 'FIRE', cell: lastCell, at: 2 });

    expect(isDead(next.session!.state.players[0]!)).toBe(true);
    // The engagement itself is not over — seats 1 and 2 still have a duel to play.
    expect(next.session!.state.phase.kind).toBe('playing');
    expect(next.screen.kind).toBe('gameover');
  });

  it('stays on the game screen while the human still holds a hull', () => {
    const { state } = onLastHull();
    const app = meleeApp(state);
    // One shell short of the wipe: nothing routes anywhere.
    const hull = state.players[0]!.ships.flatMap(shipCells);
    const next = applyEngineAction(app, { type: 'FIRE', cell: hull[0]!, at: 2 });
    expect(isDead(next.session!.state.players[0]!)).toBe(false);
    expect(next.screen.kind).toBe('game');
  });

  it('sounds the defeat cue for your own fleet, and only your own', () => {
    const rng = mulberry32(21);
    const { state, lastCell } = onLastHull();
    const { events } = step(state, { type: 'FIRE', cell: lastCell, at: 2 }, rng);

    // No gameOver event fires — the game is still running — so this cue is the only
    // ending the eliminated seat ever hears.
    expect(events.some((e) => e.type === 'gameOver')).toBe(false);
    const mine = beatsForEvents(redactEventsFor(0, events), 0);
    expect(mine.some((b) => b.cue === 'end.defeat')).toBe(true);
    // The seat that fired it hears the sinking, not a defeat.
    const theirs = beatsForEvents(redactEventsFor(1, events), 1);
    expect(theirs.some((b) => b.cue === 'end.defeat')).toBe(false);
    expect(theirs.some((b) => b.cue === 'fire.sunk.enemy')).toBe(true);
  });
});
