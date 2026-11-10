import {
  AP_COST,
  FLEET,
  MAX_DECOYS,
  chebyshev,
  encodeAction,
  pingCells,
  shipCells,
  toRC,
  type Action,
  type Observation,
  type RNG,
} from '../engine';
import {
  gatherIntel,
  hottestCell,
  latestShotByCell,
  pingContactProbability,
  wakeConstraints,
  type BeliefState,
} from './montecarlo';
import {
  fireAnywhere,
  meanPositiveHeat,
  pickDeceptiveMove,
  targetBelief,
  threatBelief,
} from './kit';
import type { Bot } from './types';

export interface CommodoreTuning {
  // Monte Carlo fleet samples per decision (makeCommodore can override).
  samples: number;
  // Misses decay toward uninformative over ~this many turns (movement on).
  missDecayTurns: number;
  // Decay floor: ships slide ≤1 cell/turn, so old misses stay partly valid.
  missFloor: number;
  // A "strong target" exists when max heat ≥ ratio × mean positive heat.
  strongTargetRatio: number;
  // A hit cell is "unresolved" (wounded, unsunk ship) if P(unsunk ship) ≥ this.
  unresolvedHitProb: number;
  // Axis lock: with two collinear hits on an unsunk ship, finish ALONG that axis instead of
  // letting the heatmap wander around the wound (evidence of one hull, not proof).
  axisLock: boolean;
  // A ship counts as endangered (deceptive moves get priority) within this Chebyshev radius
  // of…
  dangerRadius: number;
  // …an enemy shot landed within the last N turns.
  dangerWindow: number;
  // Place the first decoy inside this turn window (needs 3 AP spare).
  decoyEarliestTurn: number;
  decoyLatestTurn: number;
  // Place the second decoy once this many own ships are lost.
  secondDecoyAfterLosses: number;
  // Minimum p(1−p) information score to bother pinging.
  pingMinScore: number;
  // Don't re-ping a center pinged within the last N turns.
  pingRepeatWindow: number;
  // With this few enemy ships left, triage: every AP goes to shots.
  triageAtEnemyShips: number;
  // Triage exception: minimum swept belief heat for the odd leftover AP
  // (forfeit otherwise — shots cost 2) to buy a wake-sniff ping.
  wakeSniffMinHeat: number;
  // MC samples for modelling the opponent's belief about OUR board.
  decoySamples: number;
  // Weight on "the opponent is likely to shoot here" when siting a decoy.
  decoyHeatWeight: number;
  // Weight on "keep clear of our real hulls" when siting a decoy.
  decoyDistanceWeight: number;
  // Hold the first decoy until peak threat heat ≥ ratio × mean (a focused search); before
  // that it's a random cell. Overridden at decoyLatestTurn.
  decoyMinHeatRatio: number;
  // Don't re-shoot a MISS cell within this many turns: a degenerate belief can freeze the
  // argmax on one cell; this forces it down the rank list.
  shotRepeatWindow: number;
  // A once-shot HIT cell older than this becomes targetable again (spent decoy or a ship
  // that slid onto one; one re-shot resolves either). Twice-shot HITs are never
  // re-targeted.
  reshootHitAfter: number;
}

// Every COMMODORE heuristic constant lives here. Tune freely.
const COMMODORE_TUNING: CommodoreTuning = {
  samples: 1000,
  missDecayTurns: 6,
  missFloor: 0.85,
  strongTargetRatio: 1.4,
  unresolvedHitProb: 0.5,
  axisLock: true,
  dangerRadius: 1,
  dangerWindow: 2,
  decoyEarliestTurn: 3,
  decoyLatestTurn: 16,
  secondDecoyAfterLosses: 2,
  pingMinScore: 0.18,
  pingRepeatWindow: 5,
  triageAtEnemyShips: 2,
  wakeSniffMinHeat: 0.01,
  decoySamples: 300,
  decoyHeatWeight: 3,
  decoyDistanceWeight: 1,
  decoyMinHeatRatio: 1.5,
  shotRepeatWindow: 8,
  reshootHitAfter: 12,
};

type Tuning = CommodoreTuning;

const ORTH = (cell: number): number[] => {
  const { r, c } = toRC(cell);
  const out: number[] = [];
  if (r > 0) out.push(cell - 10);
  if (r < 9) out.push(cell + 10);
  if (c > 0) out.push(cell - 1);
  if (c < 9) out.push(cell + 1);
  return out;
};

// Hit cells still owned by a live (unsunk, pinned) ship per the belief.
function unresolvedHitCells(
  obs: Observation,
  belief: BeliefState,
  t: Pick<Tuning, 'unresolvedHitProb'>,
): number[] {
  const { hitCells } = gatherIntel(obs);
  return hitCells.filter((c) => (belief.heat[c] ?? 0) >= t.unresolvedHitProb);
}

// One step along a row (1) or a column (10), staying on the board.
function stepCell(cell: number, dir: 1 | 10, sign: 1 | -1): number | null {
  const { r, c } = toRC(cell);
  if (dir === 1) {
    const nc = c + sign;
    return nc < 0 || nc > 9 ? null : r * 10 + nc;
  }
  const nr = r + sign;
  return nr < 0 || nr > 9 ? null : nr * 10 + c;
}

// Maximal runs of ≥2 adjacent collinear hit cells, with the cells that would extend each
// run.
export function hitRuns(hitCells: number[]): { cells: number[]; ends: number[] }[] {
  const set = new Set(hitCells);
  const runs: { cells: number[]; ends: number[] }[] = [];
  for (const dir of [1, 10] as const) {
    for (const cell of hitCells) {
      const back = stepCell(cell, dir, -1);
      if (back !== null && set.has(back)) continue; // not the head of this run
      const cells = [cell];
      for (;;) {
        const next = stepCell(cells[cells.length - 1]!, dir, 1);
        if (next === null || !set.has(next)) break;
        cells.push(next);
      }
      if (cells.length < 2) continue;
      const ends: number[] = [];
      const lo = stepCell(cells[0]!, dir, -1);
      const hi = stepCell(cells[cells.length - 1]!, dir, 1);
      if (lo !== null) ends.push(lo);
      if (hi !== null) ends.push(hi);
      runs.push({ cells, ends });
    }
  }
  return runs;
}

// Cells provably belonging to a sunk ship: the contiguous HIT run through the SUNK cell,
// when it is exactly the ship's length. A longer run (hulls end to end) is ambiguous:
// attribute nothing and let the belief decide.
export function sunkHitCells(obs: Observation): Set<number> {
  const out = new Set<number>();
  const hits = new Set<number>();
  for (const rec of obs.myShots) {
    if (rec.result === 'MISS') {
      hits.delete(rec.cell); // a hull slid off, or a phantom got disproved
      continue;
    }
    hits.add(rec.cell);
    if (rec.result !== 'SUNK' || rec.sunkShip === undefined) continue;
    const length = FLEET.find((f) => f.kind === rec.sunkShip)?.length;
    if (length === undefined) continue;
    for (const dir of [1, 10] as const) {
      const run = [rec.cell];
      for (let sign of [-1, 1] as const) {
        let cur = rec.cell;
        for (;;) {
          const next = stepCell(cur, dir, sign);
          if (next === null || !hits.has(next)) break;
          if (sign === -1) run.unshift(next);
          else run.push(next);
          cur = next;
        }
      }
      if (run.length === length) {
        for (const c of run) out.add(c);
        break;
      }
    }
  }
  return out;
}

// Runs the axis lock considers, longest first, excluding sunk-explained and 5-long runs. A
// run is evidence, not proof (hulls end to end, or a decoy bridging wounds). Liveness is
// rule-based on purpose: the belief is exactly what a decoy corrupts.
function liveHitRuns(obs: Observation): { cells: number[]; ends: number[] }[] {
  const retired = sunkHitCells(obs);
  return hitRuns(gatherIntel(obs).hitCells)
    .filter((r) => r.cells.length < 5 && r.cells.some((c) => !retired.has(c)))
    .sort((a, b) => b.cells.length - a.cells.length);
}

export function pickFinishingShot(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  t: Pick<Tuning, 'unresolvedHitProb'> & { axisLock?: boolean },
  rng: RNG,
): Action | null {
  const { hitCells, hitAges, misses } = gatherIntel(obs);
  if (hitCells.length === 0) return null;
  const hits = new Set(hitCells);
  const missAge = new Map(misses.map((m) => [m.cell, m.age]));
  // Resolved = hit, or missed no earlier than the wound was: a hit pins its ship, so a miss
  // from before it may be exactly where the ship slid in.
  const resolved = (cell: number, woundAge: number) =>
    hits.has(cell) || (missAge.get(cell) ?? Infinity) <= woundAge;

  // Axis lock first: a live run of two or more is EVIDENCE (not proof — see
  // liveHitRuns) of a hull's axis, so stay on the line until one end resolves.
  if (t.axisLock !== false) {
    for (const run of liveHitRuns(obs)) {
      const woundAge = Math.max(...run.cells.map((c) => hitAges[c] ?? 0));
      const ends = run.ends.filter(
        (c) => !resolved(c, woundAge) && legalSet.has(encodeAction({ type: 'FIRE', cell: c })),
      );
      if (ends.length === 0) continue; // both ends resolved: the lock is spent
      let best = ends[0]!;
      let bestHeat = -1;
      for (const cell of ends) {
        const h = (belief.heat[cell] ?? 0) + rng() * 1e-6;
        if (h > bestHeat) {
          bestHeat = h;
          best = cell;
        }
      }
      return { type: 'FIRE', cell: best };
    }
  }

  // No axis yet (a lone wound): probe the neighbourhood by heat. Liveness is the belief's
  // call — a lone hit is exactly what a spent decoy looks like.
  const wounded = unresolvedHitCells(obs, belief, t);
  if (wounded.length === 0) return null;
  const pool = new Set<number>();
  for (const hit of wounded) {
    for (const n of ORTH(hit)) if (!resolved(n, hitAges[hit] ?? 0)) pool.add(n);
  }
  if (pool.size === 0) return null;
  let best: number | null = null;
  let bestHeat = -1;
  for (const cell of pool) {
    const h = belief.heat[cell] ?? 0;
    if (h > bestHeat || (h === bestHeat && rng() < 0.5)) {
      bestHeat = h;
      best = cell;
    }
  }
  if (best === null) return null;
  const action: Action = { type: 'FIRE', cell: best };
  return legalSet.has(encodeAction(action)) ? action : null;
}

export function pickDecoy(
  obs: Observation,
  legalSet: Set<number>,
  t: Pick<
    Tuning,
    | 'decoyEarliestTurn'
    | 'decoyLatestTurn'
    | 'secondDecoyAfterLosses'
    | 'decoySamples'
    | 'decoyHeatWeight'
    | 'decoyDistanceWeight'
    | 'decoyMinHeatRatio'
  >,
  rng: RNG,
): Action | null {
  if (!obs.config.decoys || obs.ap < AP_COST.DECOY || obs.myDecoysLeft <= 0) return null;
  const placedAlready = MAX_DECOYS - obs.myDecoysLeft;
  const myLosses = obs.myShips.filter((s) => s.sunk).length;
  const wantFirst =
    placedAlready === 0 && obs.turn >= t.decoyEarliestTurn && obs.turn <= t.decoyLatestTurn;
  const wantSecond = placedAlready === 1 && myLosses >= t.secondDecoyAfterLosses;
  if (!wantFirst && !wantSecond) return null;

  // Where will they shoot next? Model their belief about our board.
  const threat = threatBelief(obs, t.decoySamples, rng);
  const meanHeat = meanPositiveHeat(threat.heat);
  const peakHeat = Math.max(0, ...threat.heat);
  // Flat map = decoy wasted on a random cell; hold until focused or out of window.
  const lastChance = obs.turn >= t.decoyLatestTurn;
  if (!lastChance && meanHeat > 0 && peakHeat < t.decoyMinHeatRatio * meanHeat) return null;

  const ownCells = new Set(obs.myShips.flatMap((s) => shipCells(s)));
  const enemyShot = new Set(obs.shotsAgainstMe.map((s) => s.cell));
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let cell = 0; cell < 100; cell++) {
    if (!legalSet.has(encodeAction({ type: 'DECOY', cell }))) continue;
    if (enemyShot.has(cell)) continue; // already resolved for them; they won't return
    let distOwn = Infinity;
    for (const oc of ownCells) distOwn = Math.min(distOwn, chebyshev(cell, oc));
    // Bait where they'll look next, but off our hulls: follow-up probing hits water.
    const score =
      (threat.heat[cell] ?? 0) * t.decoyHeatWeight +
      (Math.min(distOwn, 3) / 3) * t.decoyDistanceWeight +
      rng() * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best === null ? null : { type: 'DECOY', cell: best };
}

// Maximum-entropy sweep: the sweep whose contact bit is least predictable, mildly favouring
// wider coverage. Shared by COMMODORE, CAPTAIN and LIEUTENANT (ADMIRAL prices sweeps by VoI
// instead).
export function pickEntropyPing(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  t: Pick<Tuning, 'pingMinScore' | 'pingRepeatWindow'>,
  rng: RNG,
): Action | null {
  if (!obs.config.pings || obs.ap < obs.pingCost) return null;
  // Hit cells can't answer a sweep (sonar is live-only) — score the contact probability
  // over the cells that actually can.
  const excludeHits = new Set(gatherIntel(obs).hitCells);
  const recentCenters = new Set(
    obs.myPings.filter((p) => obs.turn - p.turn <= t.pingRepeatWindow).map((p) => p.center),
  );
  let best: number | null = null;
  let bestScore = t.pingMinScore;
  for (let center = 0; center < 100; center++) {
    if (recentCenters.has(center)) continue;
    if (!legalSet.has(encodeAction({ type: 'PING', center }))) continue;
    const p = pingContactProbability(belief, center, excludeHits);
    // Coverage bonus: an edge-clipped sweep reads less water.
    const score = p * (1 - p) * (0.9 + pingCells(center).length / 90) + rng() * 0.005;
    if (score > bestScore) {
      bestScore = score;
      best = center;
    }
  }
  return best === null ? null : { type: 'PING', center: best };
}

// Weight on covering the vacated cells themselves: that water is where the latent trail
// actually lies, and dredging it is the whole point.
const WAKE_TRAIL_WEIGHT = 0.5;

// Spend the odd leftover AP dredging a dodger's fresh (drift-0) trail,
// scoring swept belief heat plus coverage of the vacated cells. No repeat window: the trail
// moves. Without the drift-0 gate it degenerates into re-sweeping the hottest region.
export function pickWakeSniff(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  t: Pick<Tuning, 'wakeSniffMinHeat'>,
  rng: RNG,
): Action | null {
  if (!obs.config.pings || obs.ap < obs.pingCost) return null;
  const fresh = wakeConstraints(obs).find((w) => w.drift === 0);
  if (!fresh) return null;
  const trail = new Set(fresh.cells);
  let best: number | null = null;
  let bestScore = t.wakeSniffMinHeat;
  for (let center = 0; center < 100; center++) {
    if (!legalSet.has(encodeAction({ type: 'PING', center }))) continue;
    let score = 0;
    for (const c of pingCells(center)) {
      score += belief.heat[c] ?? 0;
      if (trail.has(c)) score += WAKE_TRAIL_WEIGHT;
    }
    score += rng() * 1e-4;
    if (score > bestScore) {
      bestScore = score;
      best = center;
    }
  }
  return best === null ? null : { type: 'PING', center: best };
}

// Sonar for AP a shell can't use: dredge a fresh wake first (when `sniff` and movement is
// on; it re-aims this turn's shells), else fall back to the rank's own `sweep`.
export function sonarSpend(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  t: Pick<Tuning, 'wakeSniffMinHeat'>,
  rng: RNG,
  sniff: boolean,
  sweep: () => Action | null,
): Action | null {
  const wake = sniff && obs.config.movement ? pickWakeSniff(obs, belief, legalSet, t, rng) : null;
  return wake ?? sweep();
}

// Age-aware exclusion: under movement, "resolved" cells can un-resolve (ships slide under
// old misses; spent decoys leave phantom HITs ships can later slide onto).
export function buildShotExclusions(
  obs: Observation,
  t: Pick<Tuning, 'shotRepeatWindow' | 'reshootHitAfter'>,
): Set<number> {
  const shotCountAt = new Map<number, number>();
  for (const s of obs.myShots) shotCountAt.set(s.cell, (shotCountAt.get(s.cell) ?? 0) + 1);
  // A MISS inside the freshest wake ring that predates the wake stays shootable, or the
  // argmax is forbidden from the kill cell.
  const freshestWake = wakeConstraints(obs)[0];
  const exclude = new Set<number>();
  for (const [cell, rec] of latestShotByCell(obs.myShots)) {
    const age = obs.turn - rec.turn;
    if (!obs.config.movement) {
      exclude.add(cell); // everything is final without movement
    } else if (rec.result === 'MISS') {
      const preWakeRing =
        freshestWake !== undefined && freshestWake.ring.has(cell) && rec.turn < freshestWake.turn;
      if (age < t.shotRepeatWindow && !preWakeRing) exclude.add(cell); // don't hammer one cell
    } else if (age <= t.reshootHitAfter || (shotCountAt.get(cell) ?? 0) >= 2) {
      // Fresh hit: finishing logic owns it. Twice-shot HIT: verified real segment.
      exclude.add(cell);
    }
    // A stale once-shot "hit" stays targetable: one re-shot resolves it.
  }
  return exclude;
}

// COMMODORE — COMMANDER's MC core + Flotilla dynamics: aged misses, ping evidence,
// finishing pinned ships first, deceptive moves, a plausible decoy, and entropy pings on
// leftover AP.
export function makeCommodore(
  samples = COMMODORE_TUNING.samples,
  tuning: Tuning = COMMODORE_TUNING,
): Bot {
  return (obs, legal, rng) => {
    const legalSet = new Set(legal);
    if (legalSet.size <= 1) return { type: 'PASS' };

    const belief = targetBelief(obs, samples, obs.config.movement ? tuning.missDecayTurns : null, tuning.missFloor, rng);

    // Triage: enemy nearly dead → every AP goes to shots.
    const triage = obs.enemyShipsRemaining <= tuning.triageAtEnemyShips;

    if (obs.ap >= AP_COST.FIRE) {
      const finishing = pickFinishingShot(obs, belief, legalSet, tuning, rng);
      if (finishing) return finishing;
    }

    // Triage's odd leftover AP can't buy a shot (cost 2), so it goes to sonar: a fresh wake
    // first (re-aims this turn's shots), else any allowed sweep beats forfeiting the point.
    if (triage && obs.ap % 2 === 1) {
      const spare = sonarSpend(obs, belief, legalSet, tuning, rng, true, () =>
        pickEntropyPing(obs, belief, legalSet, tuning, rng));
      if (spare) return spare;
    }

    if (!triage) {
      const decoy = pickDecoy(obs, legalSet, tuning, rng);
      if (decoy) return decoy;

      const deceive = pickDeceptiveMove(obs, legalSet, tuning, rng);
      if (deceive) return deceive;
    }

    const exclude = buildShotExclusions(obs, tuning);
    const target = hottestCell(belief.heat, exclude, rng);
    const meanHeat = meanPositiveHeat(belief.heat);
    const strong =
      target !== null && meanHeat > 0 && (belief.heat[target] ?? 0) >= tuning.strongTargetRatio * meanHeat;

    if (obs.ap >= AP_COST.FIRE && strong) {
      const action: Action = { type: 'FIRE', cell: target };
      if (legalSet.has(encodeAction(action))) return action;
    }

    if (!triage && obs.ap % 2 === 1) {
      const ping = pickEntropyPing(obs, belief, legalSet, tuning, rng);
      if (ping) return ping;
    }

    if (obs.ap >= AP_COST.FIRE && target !== null) {
      const action: Action = { type: 'FIRE', cell: target };
      if (legalSet.has(encodeAction(action))) return action;
    }

    // Leftover 1 AP with nothing good to shoot: ping if it teaches anything.
    if (!triage) {
      const lastPing = pickEntropyPing(obs, belief, legalSet, tuning, rng);
      if (lastPing) return lastPing;
    }

    return fireAnywhere(obs, belief, legalSet, rng) ?? { type: 'PASS' };
  };
}
