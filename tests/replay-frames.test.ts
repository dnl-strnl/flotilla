import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  createGame,
  decodeAction,
  exportReplay,
  legalActionIds,
  mulberry32,
  randomFleet,
  replayFrames,
  rngPick,
  runReplay,
  step,
  type Action,
  type Event,
  type Replay,
  type ShipPlacement,
} from '../src/engine';

// A finished random game packaged as a Replay (same recipe as determinism.test).
function randomReplay(seed: number): Replay {
  const rng = mulberry32(seed);
  const placements: [ShipPlacement[], ShipPlacement[]] = [randomFleet(rng), randomFleet(rng)];
  let state = createGame(PRESETS.FLOTILLA, structuredClone(placements), seed);
  const actions: Action[] = [];
  const events: Event[] = [];
  let guard = 0;
  while (state.phase.kind === 'playing' && guard++ < 5000) {
    const action = decodeAction(rngPick(rng, legalActionIds(state)));
    const r = step(state, action, rng);
    state = r.state;
    actions.push(action);
    events.push(...r.events);
  }
  return exportReplay(PRESETS.FLOTILLA, seed, 0, placements, actions, events);
}

describe('replayFrames', () => {
  it('yields one frame per action plus the deployment frame, in step order', () => {
    const replay = randomReplay(99);
    const frames = replayFrames(replay);
    expect(frames).toHaveLength(replay.actions.length + 1);
    expect(frames[0]!.action).toBeNull();
    expect(frames[0]!.events).toEqual([]);
    expect(frames[0]!.state.turn).toBe(1);
    frames.slice(1).forEach((frame, i) => {
      expect(frame.action).toEqual(replay.actions[i]);
    });
  });

  it('agrees with runReplay on the final state and the concatenated event log', () => {
    const replay = randomReplay(123);
    const frames = replayFrames(replay);
    const rerun = runReplay(replay);
    expect(JSON.stringify(frames.at(-1)!.state)).toBe(JSON.stringify(rerun.state));
    expect(JSON.stringify(frames.flatMap((f) => f.events))).toBe(JSON.stringify(replay.events));
  });

  it('throws on a tampered action log instead of rendering nonsense', () => {
    const replay = randomReplay(7);
    // Duplicate the final action: the game is over, so any further step is illegal.
    const tampered: Replay = structuredClone(replay);
    tampered.actions.push(tampered.actions.at(-1)!);
    expect(() => replayFrames(tampered)).toThrow();
  });

  it('throws on corrupt placements', () => {
    const replay = randomReplay(7);
    const tampered: Replay = structuredClone(replay);
    tampered.placements[0] = [];
    expect(() => replayFrames(tampered)).toThrow();
  });
});
