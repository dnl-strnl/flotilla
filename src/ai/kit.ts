import {
  AP_COST,
  MOVE_BASE,
  MOVE_DIRS,
  chebyshev,
  encodeAction,
  movedOrigin,
  shipCells,
  type Action,
  type Observation,
  type RNG,
} from '../engine';
import { buildBelief, hottestCell, type BeliefState } from './montecarlo';

// Building blocks every heatmap rank shares: belief builds, the hull-slide scorer, the
// last-resort shot. Rank-specific picks (decoys, sweeps, finishing) live in commodore.ts.

// The rank's own belief about the enemy board. `missDecayTurns` null = misses are final.
export function targetBelief(
  obs: Observation,
  samples: number,
  missDecayTurns: number | null,
  missFloor: number,
  rng: RNG,
): BeliefState {
  return buildBelief(
    obs,
    { samples, missDecayTurns, missFloor, usePings: obs.config.pings, maxAttempts: 12 },
    rng,
  );
}

// Reconstruct what the opponent was TOLD about our board (heatmap of their next shot).
// Exact, no leaked info: their hits sit on pinned damaged segments, spent decoys were
// reported HIT, everything else MISS. Their pings: unknowable, omitted.
export function opponentViewOfOurBoard(obs: Observation): Observation {
  const damagedCells = new Set<number>();
  for (const ship of obs.myShips) {
    shipCells(ship).forEach((cell, segment) => {
      if (ship.hits[segment]) damagedCells.add(cell);
    });
  }
  const spentDecoys = new Set(obs.myDecoys.filter((d) => d.spent).map((d) => d.cell));

  // Re-shoots put multiple records on one cell, so use a temporal rule (exact for the
  // latest record per cell, all the sampler reads): a damaged segment's LAST shot hit,
  // earlier ones missed; a spent decoy's FIRST shot hit, later ones missed.
  const firstIdxAt = new Map<number, number>();
  const lastIdxAt = new Map<number, number>();
  obs.shotsAgainstMe.forEach(({ cell }, i) => {
    if (!firstIdxAt.has(cell)) firstIdxAt.set(cell, i);
    lastIdxAt.set(cell, i);
  });
  const asTheySawIt = obs.shotsAgainstMe.map(({ cell, turn }, i) => {
    const hit =
      (damagedCells.has(cell) && lastIdxAt.get(cell) === i) ||
      (spentDecoys.has(cell) && firstIdxAt.get(cell) === i);
    return { cell, result: (hit ? 'HIT' : 'MISS') as 'HIT' | 'MISS', turn };
  });

  return {
    ...obs,
    myShots: asTheySawIt,
    myPings: [],
    enemySunk: obs.myShips.filter((s) => s.sunk).map((s) => s.kind),
    enemyShipsRemaining: obs.myShips.filter((s) => !s.sunk).length,
  };
}

// The opponent's belief about OUR board, modeled as a classic searcher: misses final, no
// pings. Drives decoy siting and every defensive slide.
export function threatBelief(obs: Observation, samples: number, rng: RNG): BeliefState {
  return buildBelief(
    opponentViewOfOurBoard(obs),
    { samples, missDecayTurns: null, usePings: false, maxAttempts: 12 },
    rng,
  );
}

// Mean of the positive cells of a heatmap (0 when none): the bar a "strong target" clears.
export function meanPositiveHeat(heat: Float64Array): number {
  const heats = Array.from(heat).filter((h) => h > 0);
  return heats.length ? heats.reduce((a, b) => a + b, 0) / heats.length : 0;
}

// Cheap pre-check: is ANY move legal right now? Skips the costly threat build otherwise.
export function anyMoveLegal(legalSet: Set<number>): boolean {
  for (let id = MOVE_BASE; id < MOVE_BASE + 20; id++) if (legalSet.has(id)) return true;
  return false;
}

// Within `dangerRadius` of an enemy shell from the last `dangerWindow` turns.
function dangerTest(
  obs: Observation,
  t: { dangerRadius: number; dangerWindow: number },
): (cells: number[]) => boolean {
  const recent = obs.shotsAgainstMe.filter((s) => obs.turn - s.turn <= t.dangerWindow);
  return (cells) => cells.some((cell) => recent.some((s) => chebyshev(cell, s.cell) <= t.dangerRadius));
}

// The best legal one-step slide of an undamaged hull, by `score` (null = not a candidate).
// Ships and directions are walked in id order, so rng draws inside `score` stay in step.
function bestSlide(
  obs: Observation,
  legalSet: Set<number>,
  score: (cells: number[], moved: number[]) => number | null,
): { action: Action; score: number } | null {
  let best: { action: Action; score: number } | null = null;
  obs.myShips.forEach((ship, idx) => {
    if (ship.sunk || ship.hits.some(Boolean)) return; // damage pins a hull anyway
    const cells = shipCells(ship);
    MOVE_DIRS.forEach((dir, dirIndex) => {
      if (!legalSet.has(MOVE_BASE + idx * 4 + dirIndex)) return;
      const dest = movedOrigin(ship, dir);
      if (dest === null) return;
      const s = score(cells, shipCells({ ...ship, origin: dest }));
      if (s !== null && (!best || s > best.score)) best = { action: { type: 'MOVE', ship: idx, dir }, score: s };
    });
  });
  return best;
}

export interface EvasionTuning {
  // Minimum exposure drop for a MOVE to be considered at all (kills shuffling).
  defEpsilon: number;
  // A hull within this Chebyshev radius of an enemy shell from the last dangerWindow turns
  // is endangered, and earns endangeredBonus for moving.
  dangerRadius: number;
  dangerWindow: number;
  endangeredBonus: number;
  // Penalty per vacated (wake) cell (a sideways step leaks the whole footprint, an
  // along-axis step one cell). Absent = 0.
  wakeLeakWeight?: number;
}

// The slide that sheds the most hull exposure under the modeled opponent belief: onto
// squares they already shot (their resolved MISS becomes a lie) and out of their hot zones,
// minus a wake-leak term.
export function pickEvasiveMove(
  obs: Observation,
  threat: BeliefState,
  legalSet: Set<number>,
  t: EvasionTuning,
  rng: RNG,
): { action: Action; def: number } | null {
  if (!obs.config.movement || obs.ap < AP_COST.MOVE) return null;
  if (!anyMoveLegal(legalSet)) return null;
  const exposure = (cells: number[]): number => {
    let e = 0;
    for (const c of cells) e += threat.heat[c] ?? 0;
    return e;
  };
  const inDanger = dangerTest(obs, t);
  const leak = t.wakeLeakWeight ?? 0;
  const best = bestSlide(obs, legalSet, (cells, moved) => {
    const vacated = cells.filter((c) => !moved.includes(c)).length;
    const def =
      exposure(cells) - exposure(moved) +
      (inDanger(cells) ? t.endangeredBonus : 0) -
      vacated * leak +
      rng() * 1e-4;
    return def > t.defEpsilon ? def : null;
  });
  return best && { action: best.action, def: best.score };
}

// MOVE only when the slide parks MORE hull on squares they already shot: resolved squares
// are never revisited, so their recorded MISS becomes a lie. Endangered hulls first.
export function pickDeceptiveMove(
  obs: Observation,
  legalSet: Set<number>,
  t: { dangerRadius: number; dangerWindow: number },
  rng: RNG,
): Action | null {
  if (!obs.config.movement || obs.ap < AP_COST.MOVE) return null;
  const guessed = new Set(obs.shotsAgainstMe.map((s) => s.cell));
  if (guessed.size === 0) return null;
  const overlap = (cells: number[]): number => {
    let n = 0;
    for (const cell of cells) if (guessed.has(cell)) n++;
    return n;
  };
  const inDanger = dangerTest(obs, t);
  const best = bestSlide(obs, legalSet, (cells, moved) => {
    const gain = overlap(moved) - overlap(cells);
    if (gain <= 0) return null;
    // Endangered ships first: hides the hull AND vacates the swept neighborhood.
    return gain + (inDanger(cells) ? 0.5 : 0) + rng() * 0.1;
  });
  return best ? best.action : null;
}

// Desperation fallback: the hottest legal shot, exclusions ignored (the board resolved
// without a kill — a hull slid behind a stale miss).
export function fireAnywhere(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  rng: RNG,
): Action | null {
  if (obs.ap < AP_COST.FIRE) return null;
  const any = hottestCell(belief.heat, new Set(), rng);
  if (any === null || !legalSet.has(encodeAction({ type: 'FIRE', cell: any }))) return null;
  return { type: 'FIRE', cell: any };
}
