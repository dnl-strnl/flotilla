import { describe, expect, it } from 'vitest';
import { PRESETS, createGame, mulberry32, step, type GameState } from '../src/engine';
import { TEST_FLEET } from './helpers';

// Regressions for two MELEE sonar leaks: SCAN/ECHO reading decoys differently from
// PING, and wake trails only one rival could ever dredge.

const rng = mulberry32(5);
const melee = (): GameState =>
  createGame(
    PRESETS.FLOTILLA,
    [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    7,
  );

function damage(state: GameState, seat: number, n: number): GameState {
  const s = structuredClone(state);
  let left = n;
  for (const ship of s.players[seat]!.ships) {
    for (let i = 0; i < ship.hits.length && left > 0; i++) {
      if (!ship.hits[i]) {
        ship.hits[i] = true;
        left--;
      }
    }
    ship.sunk = ship.hits.every(Boolean);
  }
  return s;
}

function handTo(state: GameState, seat: number): GameState {
  let s = state;
  while (s.activePlayer !== seat) s = step(s, { type: 'PASS' }, rng).state;
  return s;
}

describe('sonar fairness', () => {
  it('a live decoy answers SCAN and ECHO exactly as it answers PING', () => {
    // Seat 1 hides a decoy in open water (no ship within the 2x2 at 88).
    let s = handTo(damage(melee(), 0, 5), 1);
    s = step(s, { type: 'DECOY', cell: 99 }, rng).state;
    s = handTo(s, 0);
    const scan = step(s, { type: 'SCAN', cell: 88, at: 1 }, rng);
    expect(scan.events.find((e) => e.type === 'scan')).toMatchObject({ contact: true });
    const echo = step(s, { type: 'ECHO', cell: 66, at: 1 }, rng);
    expect(echo.events.find((e) => e.type === 'echo')).toMatchObject({ contact: true });
  });

  it('in the final duel either survivor can dredge the other one’s wake', () => {
    // Seat 1 is out, so its empty slot sits between seat 0 and seat 2.
    let s = handTo(damage(melee(), 1, 17), 0);
    s = step(s, { type: 'MOVE', ship: 4, dir: 'S' }, rng).state; // destroyer 80-81 → 90-91
    s = handTo(s, 2);
    const ping = step(s, { type: 'PING', center: 81, at: 1 }, rng);
    const ev = ping.events.find((e) => e.type === 'ping') as { wakes?: { cells: number[] }[] };
    expect(ev.wakes?.flatMap((w) => w.cells).sort()).toEqual([80, 81]);
  });
});
