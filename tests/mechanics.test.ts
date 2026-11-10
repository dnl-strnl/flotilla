import { describe, expect, it } from 'vitest';
import {
  legalActions,
  observe,
  pingCells,
  redactEventsFor,
  toCell,
  type Action,
  type GameState,
} from '../src/engine';
import { decoy, move, newGame, pass, ping, run, shot, shotsBy } from './helpers';

// The settled v0.1.0 rules, pinned so a sweep can't quietly regress one.

// Ship indices the active player may MOVE right now.
function movableShips(state: GameState): Set<number> {
  return new Set(
    legalActions(state)
      .filter((a): a is Extract<Action, { type: 'MOVE' }> => a.type === 'MOVE')
      .map((a) => a.ship),
  );
}

describe('ping sweep geometry', () => {
  it('is the centered 3×3, clipped at edges', () => {
    expect(pingCells(toCell(4, 4))).toHaveLength(9);
    expect(pingCells(0)).toHaveLength(4);
  });

  it('records and reports all nine cells', () => {
    const r = run(newGame(), [ping(44)]);
    expect(r.state.players[0].pings[0]!.cells).toHaveLength(9);
  });
});

describe('MOVE price', () => {
  it('a lone 1 AP cannot buy a MOVE', () => {
    const r = run(newGame(), [shot(90), shot(91)]);
    expect(r.state.ap).toBe(1);
    const types = new Set(legalActions(r.state).map((a) => a.type));
    expect(types.has('MOVE')).toBe(false);
  });
});

describe('live-only sonar', () => {
  it('a damaged segment goes sonar-dark; un-hit segments keep answering', () => {
    // Hit battleship cell 23. Center 34's 3×3 (rows 2–4, cols 3–5) contains only that
    // damaged segment; center 21's sweep reaches un-hit 20..22.
    const r = run(newGame(), [shot(23), ping(34), ping(21)]);
    expect(r.state.players[0].pings.map((p) => p.contact)).toEqual([false, true]);
  });

  it('a wreck pings clean', () => {
    // Sink the destroyer (80,81); center 90's sweep covers only the wreck.
    const r = run(newGame(), [shot(80), shot(81), ping(90)]);
    expect(shotsBy(r.state, 0)[1]).toMatchObject({ result: 'SUNK' });
    expect(r.state.players[0].pings[0]).toMatchObject({ contact: false });
  });

  it('makes a decoy fake HIT sonar-indistinguishable from a real one', () => {
    // P1 decoys open water at 35; P0 "hits" it and really hits battleship 23. Both regions
    // read clean afterwards, so sonar can't authenticate the hit.
    const r = run(newGame(), [pass, decoy(35), pass, shot(35), shot(23), pass, pass, ping(34), ping(35)]);
    expect(r.state.players[0].pings.map((p) => p.contact)).toEqual([false, false]);
  });
});

describe('move wake (the trail lingers; only sonar finds it)', () => {
  it('a move broadcasts nothing: opaque activity blip, no wake intel, trail recorded', () => {
    // Destroyer 80,81 slides N to 70,71 — both old cells enter the trail.
    const r = run(newGame(), [move(4, 'N')]);
    expect(r.state.players[0].wakeTrail).toEqual([{ cells: [80, 81], turn: 1 }]);
    expect(r.state.players[1].wakes).toEqual([]);
    expect(observe(r.state, 1).enemyWakes).toEqual([]);
    const forP1 = redactEventsFor(1, r.events);
    expect(forP1.some((e) => e.type === 'move')).toBe(false);
    expect(forP1.some((e) => e.type === 'enemyActivity')).toBe(true);
  });

  it('an along-axis step trails exactly the vacated tail cell', () => {
    // Cruiser 40..42 slides E to 41..43 — only 40 is vacated.
    const r = run(newGame(), [move(2, 'E')]);
    expect(r.state.players[0].wakeTrail).toEqual([{ cells: [40], turn: 1 }]);
  });

  it('a sweep on the very next turn dredges the wake cells it covers', () => {
    // P0's destroyer leaves 80,81 (turn 1); P1 pings 91 on turn 2 — the 3×3 covers both
    // vacated cells and no live ship (the mover is at 70,71 now).
    const r = run(newGame(), [move(4, 'N'), pass, ping(91)]);
    expect(r.state.players[1].wakes).toEqual([{ cells: [80, 81], turn: 1 }]);
    expect(observe(r.state, 1).enemyWakes).toEqual([{ cells: [80, 81], turn: 1 }]);
    const ev = r.events.find((e) => e.type === 'ping' && e.by === 1);
    // Dredged cells ride the pinger's own event; contact stays ships+decoys only.
    expect(ev && ev.type === 'ping' && ev.wakes).toEqual([{ cells: [80, 81], turn: 1 }]);
    expect(ev && ev.type === 'ping' && ev.contact).toBe(false);
    // The wake's owner never learns the sweep happened, let alone what it found.
    const forP0 = redactEventsFor(0, r.events);
    expect(forP0.filter((e) => e.type === 'enemyActivity')).toHaveLength(1);
    expect(JSON.stringify(forP0)).not.toContain('wakes');
  });

  it('reveals only the swept subset; a later sweep dredges just the remainder', () => {
    // Ping 92 covers vacated 81 but not 80; the follow-up ping 91 covers both but 81 is
    // already known — only 80 is newly dredged.
    const r = run(newGame(), [move(4, 'N'), pass, ping(92), ping(91)]);
    expect(r.state.players[1].wakes).toEqual([
      { cells: [81], turn: 1 },
      { cells: [80], turn: 1 },
    ]);
    const pings = r.events.filter((e) => e.type === 'ping' && e.by === 1);
    expect(pings[0] && pings[0].type === 'ping' && pings[0].wakes).toEqual([{ cells: [81], turn: 1 }]);
    expect(pings[1] && pings[1].type === 'ping' && pings[1].wakes).toEqual([{ cells: [80], turn: 1 }]);
  });

  it('the water smooths over: a sweep any later than your next turn finds nothing', () => {
    // Move on turn 1; P1 spends turn 2 elsewhere; by P1's turn 4 the trail is gone.
    const r = run(newGame(), [move(4, 'N'), pass, pass, pass, ping(91)]);
    expect(r.state.players[1].wakes).toEqual([]);
    const ev = r.events.find((e) => e.type === 'ping' && e.by === 1);
    expect(ev && ev.type === 'ping' && ev.wakes).toBeUndefined();
  });
});

describe('no move cooldown', () => {
  it('the same ship may move again on its owner’s next turn', () => {
    const r = run(newGame(), [move(2, 'E'), pass, pass]);
    expect(movableShips(r.state).has(2)).toBe(true);
  });
});
