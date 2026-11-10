import { FLEET, CELL_COUNT } from './types';
import type { Cell, Orient, RNG, Ship, ShipPlacement } from './types';
import { cellsFor, fitsOnBoard } from './board';
import { rngInt } from './rng';

export interface PlacementError {
  shipIndex: number;
  reason: 'wrong-fleet' | 'out-of-bounds' | 'overlap';
}

function lengthOf(kind: ShipPlacement['kind']): number {
  const spec = FLEET.find((f) => f.kind === kind);
  if (!spec) throw new Error(`unknown ship kind: ${kind}`);
  return spec.length;
}

// Validate a full fleet placement: exactly the canonical 5 ships in canonical order, all in
// bounds, no overlaps. Touching is allowed.
export function validateFleet(placements: ShipPlacement[]): PlacementError[] {
  const errors: PlacementError[] = [];
  if (
    placements.length !== FLEET.length ||
    placements.some((p, i) => p.kind !== FLEET[i]?.kind)
  ) {
    return [{ shipIndex: -1, reason: 'wrong-fleet' }];
  }
  const occupied = new Array<boolean>(CELL_COUNT).fill(false);
  placements.forEach((p, i) => {
    const length = lengthOf(p.kind);
    if (!fitsOnBoard(p.origin, p.orient, length)) {
      errors.push({ shipIndex: i, reason: 'out-of-bounds' });
      return;
    }
    for (const cell of cellsFor(p.origin, p.orient, length)) {
      if (occupied[cell]) {
        errors.push({ shipIndex: i, reason: 'overlap' });
        return;
      }
    }
    for (const cell of cellsFor(p.origin, p.orient, length)) occupied[cell] = true;
  });
  return errors;
}

// Whether one candidate ship placement is legal against already-placed ships.
export function canPlace(
  origin: Cell,
  orient: Orient,
  length: number,
  occupiedCells: readonly Cell[],
): boolean {
  if (!fitsOnBoard(origin, orient, length)) return false;
  const occupied = new Set(occupiedCells);
  return cellsFor(origin, orient, length).every((c) => !occupied.has(c));
}

export function placementToShip(p: ShipPlacement): Ship {
  const length = lengthOf(p.kind);
  return {
    kind: p.kind,
    length,
    origin: p.origin,
    orient: p.orient,
    hits: new Array<boolean>(length).fill(false),
    sunk: false,
  };
}

// Uniform-random legal fleet (used by auto-place, bots' samplers, and sims).
export function randomFleet(rng: RNG): ShipPlacement[] {
  // Rejection-sample ship by ship; restart on a dead end (rare on a 10×10).
  for (;;) {
    const placements: ShipPlacement[] = [];
    const occupied: Cell[] = [];
    let failed = false;
    for (const spec of FLEET) {
      let placed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const orient: Orient = rng() < 0.5 ? 'H' : 'V';
        const origin = rngInt(rng, CELL_COUNT);
        if (canPlace(origin, orient, spec.length, occupied)) {
          placements.push({ kind: spec.kind, origin, orient });
          occupied.push(...cellsFor(origin, orient, spec.length));
          placed = true;
          break;
        }
      }
      if (!placed) {
        failed = true;
        break;
      }
    }
    if (!failed) return placements;
  }
}
