import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, mulberry32, step } from '../src/engine';
import { initialState, reducer, type AppState } from '../src/ui/state';
import { TEST_FLEET } from './helpers';

// MELEE final duel with the NEAREST seat sunk: the survivor sits at offset 2, so its
// FIRE/PING ids live in the extension plane. The action bar must still arm them.

describe('tool arming in the MELEE duel', () => {
  it('arms PING and cycles to FIRE when the next seat is the one sunk', () => {
    const fleets: [typeof TEST_FLEET, typeof TEST_FLEET, typeof TEST_FLEET] = [
      structuredClone(TEST_FLEET),
      structuredClone(TEST_FLEET),
      structuredClone(TEST_FLEET),
    ];
    let state = createGame(PRESETS.FLOTILLA, fleets, 3);
    while (state.activePlayer !== 0) state = step(state, { type: 'PASS' }, mulberry32(1)).state;
    for (const ship of state.players[1]!.ships) {
      ship.hits = ship.hits.map(() => true);
      ship.sunk = true;
    }
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
      screen: { kind: 'game', perspective: 0, tool: 'MOVE', selectedShip: null },
    };

    const pinged = reducer(app, { t: 'SET_TOOL', tool: 'PING' });
    expect(pinged.screen.kind === 'game' && pinged.screen.tool).toBe('PING');

    const back1 = reducer(app, { t: 'CYCLE_TOOL', delta: -1 });
    expect(back1.screen.kind === 'game' && back1.screen.tool).toBe('PING');
    const back2 = reducer(back1, { t: 'CYCLE_TOOL', delta: -1 });
    expect(back2.screen.kind === 'game' && back2.screen.tool).toBe('FIRE');
  });
});
