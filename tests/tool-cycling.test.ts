import { describe, expect, it } from 'vitest';
import { PRESETS, type PresetName } from '../src/engine';
import { initialState, reducer, type AppState, type Session, type Tool } from '../src/ui/state';
import { TEST_FLEET, newGame } from './helpers';

// Human seat 0 to act, fresh FLOTILLA game unless told otherwise.
function gameApp(preset: PresetName = 'FLOTILLA', patch?: { ap?: number; myTurn?: boolean }): AppState {
  const config = PRESETS[preset];
  const state = newGame(config);
  const session: Session = {
    setup: { ...initialState.setup, preset },
    config,
    placements: [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    state: { ...state, ...(patch?.ap !== undefined ? { ap: patch.ap } : {}) },
    actions: [],
    events: [],
    bots: patch?.myTurn === false ? ['admiral', null] : [null, 'admiral'],
    concealed: false,
  };
  return {
    ...initialState,
    session,
    screen: { kind: 'game', perspective: 0, tool: 'FIRE', selectedShip: null },
  };
}

function armedTool(app: AppState): Tool {
  if (app.screen.kind !== 'game') throw new Error('not on the game screen');
  return app.screen.tool;
}

function cycle(app: AppState, delta: 1 | -1): AppState {
  return reducer(app, { t: 'CYCLE_TOOL', delta });
}

describe('tool cycling (CYCLE_TOOL)', () => {
  it('walks the action-bar order and wraps: FIRE → PING → MOVE → DECOY → FIRE', () => {
    let app = gameApp();
    const seen: Tool[] = [armedTool(app)];
    for (let i = 0; i < 4; i++) {
      app = cycle(app, 1);
      seen.push(armedTool(app));
    }
    expect(seen).toEqual(['FIRE', 'PING', 'MOVE', 'DECOY', 'FIRE']);
  });

  it('cycles backward with wraparound: FIRE → DECOY', () => {
    expect(armedTool(cycle(gameApp(), -1))).toBe('DECOY');
  });

  it('skips tools the player cannot afford', () => {
    // 2 AP: FIRE(2), PING(1), MOVE(2) are usable; DECOY(3) is not.
    let app = gameApp('FLOTILLA', { ap: 2 });
    app = cycle(app, 1); // PING
    app = cycle(app, 1); // MOVE
    app = cycle(app, 1); // DECOY skipped → wraps to FIRE
    expect(armedTool(app)).toBe('FIRE');
  });

  it('is a no-op when it is not the human’s turn', () => {
    const app = gameApp('FLOTILLA', { myTurn: false });
    expect(cycle(app, 1)).toBe(app);
  });

  it('is a no-op when only one tool exists (CLASSIC)', () => {
    const app = gameApp('CLASSIC');
    expect(cycle(app, 1)).toBe(app);
  });

  it('disarms any selected ship when the tool changes', () => {
    const base = gameApp();
    const app =
      base.screen.kind === 'game'
        ? { ...base, screen: { ...base.screen, tool: 'MOVE' as Tool, selectedShip: 0 } }
        : base;
    const next = cycle(app, 1);
    expect(next.screen.kind === 'game' && next.screen.selectedShip).toBeNull();
  });
});

describe('SET_TOOL hotkey guard', () => {
  it('refuses to arm a tool whose action-bar button would be disabled', () => {
    const app = gameApp('FLOTILLA', { ap: 2 }); // DECOY costs 3
    expect(reducer(app, { t: 'SET_TOOL', tool: 'DECOY' })).toBe(app);
  });

  it('still allows arming FIRE (the neutral Esc/turn-flip tool) regardless', () => {
    const base = gameApp('FLOTILLA', { myTurn: false });
    const app =
      base.screen.kind === 'game' ? { ...base, screen: { ...base.screen, tool: 'PING' as Tool } } : base;
    expect(armedTool(reducer(app, { t: 'SET_TOOL', tool: 'FIRE' }))).toBe('FIRE');
  });

  it('arms usable tools as before', () => {
    expect(armedTool(reducer(gameApp(), { t: 'SET_TOOL', tool: 'MOVE' }))).toBe('MOVE');
  });
});
