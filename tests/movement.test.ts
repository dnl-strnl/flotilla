import { describe, expect, it } from 'vitest';
import {
  MOVE_BASE,
  MOVE_DIRS,
  PRESETS,
  createGame,
  encodeAction,
  legalActionIds,
  shipCells,
  type MoveDir,
  type ShipPlacement,
} from '../src/engine';
import { TEST_FLEET, doStep, move, newGame, pass, run, shot, shotsBy } from './helpers';

// Move ids currently legal, as readable "ship:DIR" pairs.
const movesOf = (state: Parameters<typeof legalActionIds>[0]) =>
  legalActionIds(state)
    .filter((id) => id >= MOVE_BASE && id < MOVE_BASE + 20)
    .map((id) => `${Math.floor((id - MOVE_BASE) / 4)}:${MOVE_DIRS[(id - MOVE_BASE) % 4]}`);

const canMove = (state: Parameters<typeof legalActionIds>[0], ship: number, dir: MoveDir) =>
  legalActionIds(state).includes(encodeAction({ type: 'MOVE', ship, dir }));

describe('MOVE legality — one cell in any direction', () => {
  it('offers every in-bounds, unobstructed direction', () => {
    // Test fleet rows are 0/2/4/6/8, so the cruiser at 40–42 (row 4) has open
    // water above and below, and open water to its east.
    const state = newGame(PRESETS.FLOTILLA);
    expect(canMove(state, 2, 'N')).toBe(true); // row 4 → row 3
    expect(canMove(state, 2, 'S')).toBe(true); // row 4 → row 5
    expect(canMove(state, 2, 'E')).toBe(true); // 40-42 → 41-43
    expect(canMove(state, 2, 'W')).toBe(false); // would leave the board
  });

  it('blocks a direction that would carry any cell off the board', () => {
    const state = newGame(PRESETS.FLOTILLA);
    // The carrier occupies row 0, so north is off-board; west is too (col 0).
    expect(canMove(state, 0, 'N')).toBe(false);
    expect(canMove(state, 0, 'W')).toBe(false);
    expect(canMove(state, 0, 'S')).toBe(true);
    expect(canMove(state, 0, 'E')).toBe(true);
  });

  it('blocks an east move off the right edge instead of wrapping to the next row', () => {
    // Regression: toCell(r, 10) silently wraps to column 0 of the next row —
    // a valid-looking cell — so a vertical ship hugging column 9 was offered
    // an "east" move that teleported it across the board.
    const eastEdge: ShipPlacement[] = [
      { kind: 'carrier', origin: 0, orient: 'H' },
      { kind: 'battleship', origin: 20, orient: 'H' },
      { kind: 'cruiser', origin: 9, orient: 'V' }, // cells 9, 19, 29
      { kind: 'submarine', origin: 60, orient: 'H' },
      { kind: 'destroyer', origin: 80, orient: 'H' },
    ];
    const state = createGame(PRESETS.FLOTILLA, [eastEdge, structuredClone(TEST_FLEET)], 1);
    expect(canMove(state, 2, 'E')).toBe(false); // col 9 → off-board, must not wrap
    expect(canMove(state, 2, 'W')).toBe(true);
    expect(canMove(state, 2, 'N')).toBe(false); // row 0
    expect(canMove(state, 2, 'S')).toBe(true);
  });

  it('a perpendicular move needs EVERY destination cell free, unlike an along-axis slide', () => {
    // Carrier 0–4 (row 0, horizontal). Battleship parked at 10–13 blocks the
    // carrier's southward step (cells 10..14 overlap it) but not its eastward
    // slide (which only needs cell 5).
    const blocked: ShipPlacement[] = [
      { kind: 'carrier', origin: 0, orient: 'H' },
      { kind: 'battleship', origin: 10, orient: 'H' },
      { kind: 'cruiser', origin: 40, orient: 'H' },
      { kind: 'submarine', origin: 60, orient: 'H' },
      { kind: 'destroyer', origin: 80, orient: 'H' },
    ];
    const state = createGame(PRESETS.FLOTILLA, [blocked, structuredClone(TEST_FLEET)], 1);
    expect(canMove(state, 0, 'S')).toBe(false); // perpendicular: 10,11,12,13 occupied
    expect(canMove(state, 0, 'E')).toBe(true); // along-axis: only cell 5 needed
  });

  it('translates the whole ship and keeps its orientation', () => {
    const state = newGame(PRESETS.FLOTILLA);
    const before = state.players[0].ships[2]!;
    expect(shipCells(before)).toEqual([40, 41, 42]);
    const r = doStep(state, move(2, 'S'));
    const after = r.state.players[0].ships[2]!;
    expect(shipCells(after)).toEqual([50, 51, 52]);
    expect(after.orient).toBe(before.orient);
    expect(r.events[0]).toMatchObject({ type: 'move', dir: 'S', from: 40, to: 50 });
  });

  it('an along-axis slide may re-use the cell the ship just vacated', () => {
    // Moving east then west returns the cruiser exactly where it started.
    const r = run(newGame(PRESETS.FLOTILLA), [move(2, 'E'), pass, pass, move(2, 'W')]);
    expect(shipCells(r.state.players[0].ships[2]!)).toEqual([40, 41, 42]);
  });

  it('blocks movement into an own alive decoy, and frees it once spent', () => {
    // P0 drops a decoy at 50, directly south of the cruiser at 40–42.
    const s1 = run(newGame(PRESETS.FLOTILLA), [decoyAt(50)]).state;
    expect(canMove(s1, 2, 'S')).toBe(false);
    // P1 shoots 50 → fake HIT consumes the decoy, vacating the cell.
    const s2 = run(s1, [pass, shot(50), pass]).state;
    expect(s2.players[0].decoys[0]!.spent).toBe(true);
    expect(canMove(s2, 2, 'S')).toBe(true);
  });

  it('allows each ship at most one move per turn, in any direction', () => {
    const state = newGame(PRESETS.FLOTILLA);
    const r = doStep(state, move(4, 'N'));
    expect(movesOf(r.state).filter((m) => m.startsWith('4:'))).toEqual([]);
    expect(movesOf(r.state).some((m) => m.startsWith('3:'))).toBe(true);
    // Resets next turn.
    const nextTurn = run(r.state, [pass, pass]).state;
    expect(movesOf(nextTurn).some((m) => m.startsWith('4:'))).toBe(true);
  });

  it('pins a ship permanently after its first hit, freezing its cells', () => {
    const r = run(newGame(PRESETS.FLOTILLA), [shot(0), pass]);
    expect(r.state.activePlayer).toBe(1);
    expect(movesOf(r.state).some((m) => m.startsWith('0:'))).toBe(false);
    expect(movesOf(r.state).some((m) => m.startsWith('1:'))).toBe(true);
    const frozen = shipCells(r.state.players[1].ships[0]!);
    const later = run(r.state, [pass, pass, pass, pass]).state;
    expect(later.activePlayer).toBe(1);
    expect(movesOf(later).some((m) => m.startsWith('0:'))).toBe(false);
    expect(shipCells(later.players[1].ships[0]!)).toEqual(frozen);
  });
});

describe('stale cell markers under movement', () => {
  it('a recorded MISS goes stale when a ship moves into that cell', () => {
    // P0 misses at 50; P1's cruiser (40–42) then steps south onto 50–52.
    const r = run(newGame(PRESETS.FLOTILLA), [shot(50), pass, move(2, 'S'), pass, shot(50)]);
    const records = shotsBy(r.state, 0).filter((s) => s.cell === 50);
    expect(records.map((s) => s.result)).toEqual(['MISS', 'HIT']);
    expect(records[0]!.turn).toBe(1);
    expect(records[1]!.turn).toBe(3);
  });

  it('re-shooting an already-hit segment reports HIT without re-sinking', () => {
    const r = run(newGame(PRESETS.FLOTILLA), [shot(80), pass, pass, shot(80)]);
    const records = shotsBy(r.state, 0).filter((s) => s.cell === 80);
    expect(records.map((s) => s.result)).toEqual(['HIT', 'HIT']);
    expect(r.state.players[1].ships[4]!.sunk).toBe(false);
  });
});

// Local helper: DECOY action (kept here to avoid widening the shared helpers).
function decoyAt(cell: number) {
  return { type: 'DECOY', cell } as const;
}
