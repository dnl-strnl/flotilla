import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, mulberry32, step, type AtLeastTwo, type ShipPlacement } from '../src/engine';
import { initialState, reducer, type AppState } from '../src/ui/state';
import { TEST_FLEET } from './helpers';

// After an action the armed tool must still be LEGAL, not merely affordable: a special goes
// on cooldown once fired, even with AP left to pay for it again.

describe('re-arming after an action', () => {
  it('drops a special that just went on cooldown', () => {
    const fleets = [
      structuredClone(TEST_FLEET),
      structuredClone(TEST_FLEET),
      structuredClone(TEST_FLEET),
    ] as AtLeastTwo<ShipPlacement[]>;
    let state = createGame(PRESETS.FLOTILLA, fleets, 3);
    while (state.activePlayer !== 0) state = step(state, { type: 'PASS' }, mulberry32(1)).state;
    // Sink seat 0's carrier: the special locker opens.
    const carrier = state.players[0]!.ships[0]!;
    carrier.hits = carrier.hits.map(() => true);
    carrier.sunk = true;
    const app: AppState = {
      ...initialState,
      session: {
        setup: { ...initialState.setup, mode: 'open' },
        config: PRESETS.FLOTILLA,
        placements: structuredClone(fleets),
        state,
        actions: [],
        events: [],
        bots: [null, 'admiral', 'admiral'],
        concealed: false,
      },
      screen: { kind: 'game', perspective: 0, tool: 'ECHO', selectedShip: null },
    };
    const next = reducer(app, { t: 'ENGINE_ACTION', action: { type: 'ECHO', cell: 0 } });
    expect(next.session!.state.ap).toBeGreaterThanOrEqual(1); // still affordable…
    expect(next.screen.kind === 'game' && next.screen.tool).toBe('FIRE'); // …but not armed
  });
});
