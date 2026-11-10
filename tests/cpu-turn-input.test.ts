import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, mulberry32, step } from '../src/engine';
import { initialState, reducer, type AppState } from '../src/ui/state';
import { TEST_FLEET } from './helpers';

// Keyboard END TURN dispatches ENGINE_ACTION PASS whoever is to act. On a CPU's turn that
// must do nothing, or a held Enter skips every CPU turn.

describe('human input during a CPU turn', () => {
  it('ignores ENGINE_ACTION while a bot holds the active seat', () => {
    let state = createGame(PRESETS.FLOTILLA, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], 3);
    if (state.activePlayer === 0) state = step(state, { type: 'PASS' }, mulberry32(1)).state;
    const app: AppState = {
      ...initialState,
      session: {
        setup: initialState.setup,
        config: PRESETS.FLOTILLA,
        placements: [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
        state,
        actions: [],
        events: [],
        bots: [null, 'admiral'],
        concealed: false,
      },
      screen: { kind: 'game', perspective: 0, tool: 'FIRE', selectedShip: null },
    };
    expect(reducer(app, { t: 'ENGINE_ACTION', action: { type: 'PASS' } })).toBe(app);
  });
});
