import { BOARD_SIZE, SPRAY_SIZE } from './types';
import type { Cell, Orient, Ship } from './types';

export function toRC(cell: Cell): { r: number; c: number } {
  return { r: Math.floor(cell / BOARD_SIZE), c: cell % BOARD_SIZE };
}

export function toCell(r: number, c: number): Cell {
  return r * BOARD_SIZE + c;
}

export function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

// King-move distance between two cells.
export function chebyshev(a: Cell, b: Cell): number {
  const ra = toRC(a);
  const rb = toRC(b);
  return Math.max(Math.abs(ra.r - rb.r), Math.abs(ra.c - rb.c));
}

// Cells occupied by a ship at a given origin/orient (positions may be off-board; validate
// separately).
export function cellsFor(origin: Cell, orient: Orient, length: number): Cell[] {
  const { r, c } = toRC(origin);
  const cells: Cell[] = [];
  for (let i = 0; i < length; i++) {
    cells.push(orient === 'H' ? toCell(r, c + i) : toCell(r + i, c));
  }
  return cells;
}

// Whether every cell of a ship at origin/orient fits on the board.
export function fitsOnBoard(origin: Cell, orient: Orient, length: number): boolean {
  const { r, c } = toRC(origin);
  if (!inBounds(r, c)) return false;
  return orient === 'H' ? c + length - 1 < BOARD_SIZE : r + length - 1 < BOARD_SIZE;
}

export function shipCells(ship: Ship): Cell[] {
  return cellsFor(ship.origin, ship.orient, ship.length);
}

// The ping region: the 3×3 centered on `center`, clipped at board edges.
export function pingCells(center: Cell): Cell[] {
  const { r, c } = toRC(center);
  const cells: Cell[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (inBounds(r + dr, c + dc)) cells.push(toCell(r + dr, c + dc));
    }
  }
  return cells;
}

// "A1".."J10" style coordinate label (rows A–J, cols 1–10).
export function cellLabel(cell: Cell): string {
  const { r, c } = toRC(cell);
  return `${String.fromCharCode(65 + r)}${c + 1}`;
}

// The 2×2 block a spray covers, `topLeft` naming its corner. Nothing is clipped: legality
// only ever offers a block that fits.
export const sprayCells = (topLeft: Cell): Cell[] => blockCells(topLeft, SPRAY_SIZE);

// Whether a square block of side `size` anchored at this top-left corner stays on the
// board.
export function blockFits(topLeft: Cell, size: number): boolean {
  const { r, c } = toRC(topLeft);
  return r + size - 1 < BOARD_SIZE && c + size - 1 < BOARD_SIZE;
}

// Whether a spray block anchored here stays on the board.
export const sprayFits = (topLeft: Cell): boolean => blockFits(topLeft, SPRAY_SIZE);

// A square block of side `size` from its top-left corner. Nothing is clipped: legality only
// ever offers a block that fits. Used by SPRAY and SCAN (2×2) and ECHO (4×4).
export function blockCells(topLeft: Cell, size: number): Cell[] {
  const { r, c } = toRC(topLeft);
  const out: Cell[] = [];
  for (let dr = 0; dr < size; dr++) for (let dc = 0; dc < size; dc++) out.push(toCell(r + dr, c + dc));
  return out;
}
