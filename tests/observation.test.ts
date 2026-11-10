import { describe, expect, it } from 'vitest';
import { PRESETS, observe, redactEventsFor } from '../src/engine';
import { decoy, move, newGame, pass, ping, run, shot, shotsBy } from './helpers';

describe('no-cheating observation', () => {
  it('contains exactly the documented fields and nothing else', () => {
    const state = newGame(PRESETS.FLOTILLA);
    const obs = observe(state, 0);
    expect(Object.keys(obs).sort()).toEqual(
      [
        'ap',
        'budget',
        'pingCost',
        'config',
        'enemyShipsRemaining',
        'enemySunk',
        'enemyWakes',
        'intel',
        'me',
        'movedShips',
        'myDecoys',
        'myDecoysLeft',
        'myHullDown',
        'myToolCooldowns',
        'myPings',
        'myShips',
        'playerCount',
        'myShots',
        'shotsAgainstMe',
        'turn',
      ].sort(),
    );
  });

  it('never leaks enemy positions, decoys, or fake-hit truth', () => {
    // P1 decoys at 35; P0 shoots it (fake HIT) and pings.
    const r = run(newGame(PRESETS.FLOTILLA), [pass, decoy(35), pass, shot(35), ping(70)]);
    const obs = observe(r.state, 0);
    // The attacker's view: a plain HIT, indistinguishable from a real one.
    expect(obs.myShots[0]).toEqual({ cell: 35, result: 'HIT', turn: 3 });
    // No decoy info from the other side; own decoys only (P0 placed none).
    expect(obs.myDecoys).toEqual([]);
    expect(obs.myDecoysLeft).toBe(2);
    // Serialized form carries no enemy ship data at all.
    const json = JSON.stringify(obs);
    expect(json).not.toContain('"players"');
    expect(json).not.toContain('"spent"'); // enemy decoy state is invisible
    // My own ships are mine (P0's canonical test fleet).
    expect(obs.myShips.map((s) => s.origin)).toEqual([0, 20, 40, 60, 80]);
  });

  it('mutating an observation cannot corrupt engine state', () => {
    const state = newGame(PRESETS.FLOTILLA);
    const obs = observe(state, 0);
    obs.myShips[0]!.origin = 55;
    obs.myShots.push({ cell: 1, result: 'HIT', turn: 1 });
    expect(state.players[0].ships[0]!.origin).toBe(0);
    expect(shotsBy(state, 0)).toEqual([]);
  });

  it('shows zero AP to the non-active player', () => {
    const state = newGame(PRESETS.FLOTILLA);
    expect(observe(state, 0).ap).toBe(5);
    expect(observe(state, 1).ap).toBe(0);
  });
});

describe('event redaction', () => {
  it('replaces opponent pings, moves, and decoys with an opaque activity marker', () => {
    // decoy+ping fill turn 2 (3+1 AP); the 2-AP move needs P1's next turn.
    const r = run(newGame(), [pass, decoy(35), ping(5), pass, pass, move(1, 'S')]);
    const forP0 = redactEventsFor(0, r.events);
    // Nothing about WHAT the opponent did survives…
    expect(forP0.some((e) => e.type === 'decoyPlaced' || e.type === 'move' || e.type === 'ping')).toBe(
      false,
    );
    // …only that they acted three times. No cell, direction, or action type.
    const opaque = forP0.filter((e) => e.type === 'enemyActivity');
    expect(opaque).toHaveLength(3);
    expect(Object.keys(opaque[0]!).sort()).toEqual(['player', 'turn', 'type']);
    expect(JSON.stringify(opaque)).not.toContain('35');
    // The actor still sees their own actions in full, and no opaque markers.
    const forP1 = redactEventsFor(1, r.events);
    expect(forP1.filter((e) => e.type === 'decoyPlaced')).toHaveLength(1);
    expect(forP1.filter((e) => e.type === 'move')).toHaveLength(1);
    expect(forP1.filter((e) => e.type === 'ping')).toHaveLength(1);
    expect(forP1.filter((e) => e.type === 'enemyActivity')).toHaveLength(0);
  });

  it('never reveals that a decoy absorbed a shot', () => {
    // P1 decoys at 35; P0 shoots it. P0 must see only a plain HIT — no
    // decoySpent event and no activity marker hinting at one.
    const r = run(newGame(PRESETS.FLOTILLA), [pass, decoy(35), pass, shot(35)]);
    const forP0 = redactEventsFor(0, r.events);
    expect(forP0.some((e) => e.type === 'decoySpent')).toBe(false);
    const shots = forP0.filter((e) => e.type === 'fire' && e.cell === 35);
    expect(shots[0]).toEqual({ type: 'fire', turn: 3, by: 0, target: 1, cell: 35, reported: 'HIT' });
  });

  it('strips truth fields from the shooter’s own shot events', () => {
    // Fake hit on a decoy, and a real sink, both viewed by the attacker.
    const r = run(newGame(PRESETS.FLOTILLA), [pass, decoy(35), pass, shot(35), shot(80), pass, pass, shot(81)]);
    const forP0 = redactEventsFor(0, r.events).filter((e) => e.type === 'fire');
    const fake = forP0.find((e) => e.type === 'fire' && e.cell === 35);
    expect(fake).toEqual({ type: 'fire', turn: 3, by: 0, target: 1, cell: 35, reported: 'HIT' });
    const sink = forP0.find((e) => e.type === 'fire' && e.cell === 81);
    expect(sink).toMatchObject({ reported: 'SUNK', sunkShip: { kind: 'destroyer' } });
    expect((sink as { sunkShip?: { cells?: unknown } }).sunkShip?.cells).toBeUndefined();
    // The defender keeps full truth about shots on their own board.
    const forP1 = redactEventsFor(1, r.events).filter((e) => e.type === 'fire');
    expect(forP1.find((e) => e.type === 'fire' && e.cell === 35)).toMatchObject({ decoy: true });
  });
});
