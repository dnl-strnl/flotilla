import { describe, expect, it } from 'vitest';
import { cellLabel, pingCells, shipCells, toCell, toRC } from '../src/engine';

describe('board geometry', () => {
  it('cell index round-trips', () => {
    for (let cell = 0; cell < 100; cell++) {
      const { r, c } = toRC(cell);
      expect(toCell(r, c)).toBe(cell);
    }
  });

  it('labels cells A1..J10', () => {
    expect(cellLabel(0)).toBe('A1');
    expect(cellLabel(9)).toBe('A10');
    expect(cellLabel(99)).toBe('J10');
    expect(cellLabel(44)).toBe('E5');
  });

  it('derives ship cells from origin/orient', () => {
    expect(
      shipCells({ kind: 'cruiser', length: 3, origin: 40, orient: 'H', hits: [], sunk: false }),
    ).toEqual([40, 41, 42]);
    expect(
      shipCells({ kind: 'cruiser', length: 3, origin: 40, orient: 'V', hits: [], sunk: false }),
    ).toEqual([40, 50, 60]);
  });

  it('clips ping regions at corners and edges', () => {
    expect(pingCells(0).sort((a, b) => a - b)).toEqual([0, 1, 10, 11]);
    expect(pingCells(99).sort((a, b) => a - b)).toEqual([88, 89, 98, 99]);
    expect(pingCells(5).sort((a, b) => a - b)).toEqual([4, 5, 6, 14, 15, 16]);
    expect(pingCells(55)).toHaveLength(9);
  });
});
