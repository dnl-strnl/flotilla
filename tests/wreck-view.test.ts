import { describe, expect, it } from 'vitest';
import {
  observe,
  shipCells,
  type Orient,
  type Ship,
  type ShipKind,
  type ShotRecord,
} from '../src/engine';
import { enemyBoardCells, ownBoardCells, sunkEnemyHulls } from '../src/ui/viewmodels';
import { newGame, pass, run, shot } from './helpers';

const ship = (origin: number, orient: Orient, length: number, sunk: boolean): Ship => ({
  kind: 'cruiser',
  length,
  origin,
  orient,
  hits: Array.from({ length }, () => sunk),
  sunk,
});

// The wreck-* perimeter classes on each cell of `s`, in segment order.
function edgesOf(s: Ship): string[][] {
  const cells = ownBoardCells({ myShips: [s], myDecoys: [], shotsAgainstMe: [] });
  return shipCells(s).map((cell) =>
    (cells[cell]!.classes ?? '')
      .split(' ')
      .filter((c) => c.startsWith('wreck-'))
      .sort(),
  );
}

describe('sunk-ship outline', () => {
  it('draws one unbroken perimeter around a horizontal hull', () => {
    // Cross-axis edges on every segment; along-axis edges only at the two ends,
    // so interior seams stay open and the five cells read as a single outline.
    expect(edgesOf(ship(40, 'H', 5, true))).toEqual([
      ['wreck-n', 'wreck-s', 'wreck-w'],
      ['wreck-n', 'wreck-s'],
      ['wreck-n', 'wreck-s'],
      ['wreck-n', 'wreck-s'],
      ['wreck-e', 'wreck-n', 'wreck-s'],
    ]);
  });

  it('draws one unbroken perimeter around a vertical hull', () => {
    expect(edgesOf(ship(3, 'V', 3, true))).toEqual([
      ['wreck-e', 'wreck-n', 'wreck-w'],
      ['wreck-e', 'wreck-w'],
      ['wreck-e', 'wreck-s', 'wreck-w'],
    ]);
  });

  it('outlines a two-cell hull with no interior seam at all', () => {
    expect(edgesOf(ship(80, 'H', 2, true))).toEqual([
      ['wreck-n', 'wreck-s', 'wreck-w'],
      ['wreck-e', 'wreck-n', 'wreck-s'],
    ]);
  });

  it('gives a floating ship the teal hull perimeter, never the wreck one', () => {
    const damaged = ship(40, 'H', 3, false);
    damaged.hits = [true, true, false];
    expect(edgesOf(damaged)).toEqual([[], [], []]); // wreck-* is reserved for the sunk
    const cells = ownBoardCells({ myShips: [damaged], myDecoys: [], shotsAgainstMe: [] });
    expect(cells[40]!.classes).toBe('own-ship damaged hull hull-n hull-s hull-w');
    expect(cells[42]!.classes).toBe('own-ship hull hull-n hull-s hull-e');
  });

  it('keeps a hull visible where it overlaps a decoy; the ◆ shrinks to a corner tag', () => {
    // The G9 lesson: a ship that slid onto its own spent decoy must not render
    // as a decoy square — that hides exactly the cell the truth view exists to show.
    const s = ship(40, 'H', 3, false);
    const cells = ownBoardCells({
      myShips: [s],
      myDecoys: [{ cell: 40, spent: true }],
      shotsAgainstMe: [],
    });
    expect(cells[40]!.classes).toContain('own-ship');
    expect(cells[40]!.tag).toBe('◆');
    expect(cells[40]!.title).toContain('DECOY (EXPENDED)');
    // On open water a decoy still owns its cell outright.
    const open = ownBoardCells({ myShips: [s], myDecoys: [{ cell: 99, spent: false }], shotsAgainstMe: [] });
    expect(open[99]!.classes).toBe('own-decoy');
    expect(open[99]!.glyph).toBe('◆');
  });

  it('marks every segment of a real sunk ship and labels it SUNK', () => {
    // Destroyer at 80..81; player 0 sinks it, so player 1's own board shows the wreck.
    const { state } = run(newGame(), [shot(80), pass, pass, shot(81)]);
    const cells = ownBoardCells(observe(state, 1));
    for (const cell of [80, 81]) {
      expect(cells[cell]!.classes).toContain('own-ship sunk');
      expect(cells[cell]!.title).toContain('(SUNK)');
    }
    expect(cells[80]!.classes).toContain('wreck-w');
    expect(cells[81]!.classes).toContain('wreck-e');
    expect(cells[80]!.classes).not.toContain('wreck-e');
  });
});

const hit = (cell: number, turn: number): ShotRecord => ({ cell, result: 'HIT', turn });
const sank = (cell: number, turn: number, sunkShip: ShipKind): ShotRecord =>
  ({ cell, result: 'SUNK', turn, sunkShip });
const missed = (cell: number, turn: number): ShotRecord => ({ cell, result: 'MISS', turn });

describe('enemy hull reconstruction (targeting grid)', () => {
  it('pins a horizontal hull from the kill shot plus the viewer’s own hits', () => {
    // Destroyer at 80..81: HIT 80, then the kill at 81.
    expect(sunkEnemyHulls([hit(80, 1), sank(81, 3, 'destroyer')])).toEqual([
      { kind: 'destroyer', orient: 'H', cells: [80, 81] },
    ]);
  });

  it('pins a vertical hull, kill shot landing mid-ship', () => {
    // Cruiser at 3/13/23, killed on the middle segment.
    expect(sunkEnemyHulls([hit(3, 1), hit(23, 2), sank(13, 4, 'cruiser')])).toEqual([
      { kind: 'cruiser', orient: 'V', cells: [3, 13, 23] },
    ]);
  });

  it('refuses to guess when the run is longer than the hull', () => {
    // 80,81,82 all struck but the dead ship is only 2 long — [80,81] and
    // [81,82] both fit, so nothing is outlined rather than outlining a lie.
    expect(sunkEnemyHulls([hit(80, 1), hit(82, 2), sank(81, 3, 'destroyer')])).toEqual([]);
  });

  it('refuses to guess when the ship moved and its markers went stale', () => {
    // Only the killing cell is struck; a 3-long hull cannot be placed.
    expect(sunkEnemyHulls([missed(40, 1), sank(55, 6, 'cruiser')])).toEqual([]);
  });

  it('never claims a cell for two hulls', () => {
    // Destroyer 80..81 dies first; a cruiser killed at 82 would want 80..82.
    const hulls = sunkEnemyHulls([
      hit(80, 1), sank(81, 2, 'destroyer'), hit(83, 3), hit(84, 4), sank(82, 5, 'cruiser'),
    ]);
    expect(hulls).toEqual([
      { kind: 'destroyer', orient: 'H', cells: [80, 81] },
      { kind: 'cruiser', orient: 'H', cells: [82, 83, 84] },
    ]);
  });

  it('does not run a hull off the edge of the board or wrap a row', () => {
    // Kill at 9 (row A, col 10). A horizontal destroyer could only be [8,9].
    expect(sunkEnemyHulls([hit(8, 1), sank(9, 2, 'destroyer')])).toEqual([
      { kind: 'destroyer', orient: 'H', cells: [8, 9] },
    ]);
    // Kill at 10 (row B, col 1): cell 9 is the previous row, never a neighbour.
    expect(sunkEnemyHulls([hit(9, 1), sank(10, 2, 'destroyer')])).toEqual([]);
  });

  it('outlines the whole hull on the targeting grid once it is pinned', () => {
    const cells = enemyBoardCells(
      { turn: 5, myPings: [], myShots: [hit(80, 1), sank(81, 3, 'destroyer')], enemyWakes: [] },
      null,
    );
    expect(cells[80]!.classes).toContain('enemy-wreck');
    expect(cells[80]!.classes).toContain('wreck-w');
    expect(cells[81]!.classes).toContain('wreck-e');
    expect(cells[80]!.title).toContain('(SUNK)');
    // The un-pinnable case keeps the plain single-cell kill marker.
    const lone = enemyBoardCells({ turn: 5, myPings: [], myShots: [sank(55, 6, 'cruiser')], enemyWakes: [] }, null);
    expect(lone[55]!.classes).toContain('fire-sunk');
    expect(lone[55]!.classes).not.toContain('enemy-wreck');
  });
});
