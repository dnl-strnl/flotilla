import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, exportReplay } from '../src/engine';
import { initialState, reducer, type AppState } from '../src/ui/state';
import { TEST_FLEET } from './helpers';

// Closing a replay opened from a three-fleet spectate must hand back one sonar toggle per
// fleet, or the third seat's overlay silently goes dark.

describe('replay opened from spectate', () => {
  it('restores a sonar toggle for every fleet on close', () => {
    const fleets = [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)];
    const state = createGame(PRESETS.FLOTILLA, fleets as [typeof TEST_FLEET, typeof TEST_FLEET], 5);
    const app: AppState = {
      ...initialState,
      session: {
        setup: initialState.setup,
        config: PRESETS.FLOTILLA,
        placements: fleets as [typeof TEST_FLEET, typeof TEST_FLEET],
        state,
        actions: [],
        events: [],
        bots: ['ensign', 'ensign', 'ensign'],
        concealed: false,
      },
      screen: { kind: 'spectate', speedMs: 300, paused: false, sonar: [true, true, true] },
    };
    const replay = exportReplay(PRESETS.FLOTILLA, 5, state.firstPlayer, app.session!.placements, [], []);
    const opened = reducer(app, { t: 'OPEN_REPLAY', replay, labels: ['A', 'B', 'C'], from: 'spectate' });
    const closed = reducer(opened, { t: 'CLOSE_REPLAY' });
    expect(closed.screen).toMatchObject({ kind: 'spectate', sonar: [true, true, true] });
  });
});
