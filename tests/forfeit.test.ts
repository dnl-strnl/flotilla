import { describe, expect, it } from 'vitest';
import { PRESETS, exportReplay, forfeit, replayFrames, upgradeReplay } from '../src/engine';
import { TEST_FLEET, newGame, doStep } from './helpers';

describe('forfeit', () => {
  it('awards the win to the opponent and marks the phase byForfeit', () => {
    const state = newGame();
    const { state: after, events } = forfeit(state, 0);
    expect(after.phase).toEqual({ kind: 'won', winner: 1, byForfeit: true });
    expect(events).toEqual([
      { type: 'gameOver', turn: state.turn, result: 'win', winner: 1, forfeit: 0 },
    ]);
    // Pure transition: the input state is untouched.
    expect(state.phase).toEqual({ kind: 'playing' });
  });

  it('throws on a finished game', () => {
    const { state } = forfeit(newGame(), 1);
    expect(() => forfeit(state, 0)).toThrow(/finished/);
  });

  it('replays saved before the SHOT → FIRE rename still play back', () => {
    const start = newGame();
    const { events } = doStep(start, { type: 'FIRE', cell: 99 });
    const replay = exportReplay(
      PRESETS.FLOTILLA,
      start.seed,
      0,
      [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
      [{ type: 'FIRE', cell: 99 }],
      events,
      0,
    );
    const legacy = JSON.parse(
      JSON.stringify(replay).replaceAll('"FIRE"', '"SHOT"').replaceAll('"fire"', '"shot"'),
    );
    const frames = replayFrames(legacy);
    expect(frames[1]!.action).toEqual({ type: 'FIRE', cell: 99 });
    expect(frames.map((f) => f.state)).toEqual(replayFrames(replay).map((f) => f.state));
    expect(upgradeReplay(legacy)).toEqual(replay);
  });

  it('replayFrames appends one action-less concession frame for Replay.forfeit', () => {
    const start = newGame();
    const { events: shotEvents } = doStep(start, { type: 'FIRE', cell: 99 });
    const replay = exportReplay(
      PRESETS.FLOTILLA,
      start.seed,
      0,
      [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
      [{ type: 'FIRE', cell: 99 }],
      shotEvents,
      0,
    );
    const frames = replayFrames(replay);
    expect(frames).toHaveLength(3); // deployment + the shot + the concession
    const last = frames[frames.length - 1]!;
    expect(last.action).toBeNull();
    expect(last.state.phase).toEqual({ kind: 'won', winner: 1, byForfeit: true });
    expect(last.events[0]).toMatchObject({ type: 'gameOver', winner: 1, forfeit: 0 });
  });
});
