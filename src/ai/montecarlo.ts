import { FLEET, MAX_DECOYS, pingCells, toRC, type Observation, type RNG, type ShipKind, type ShotRecord } from '../engine';
import { rngInt, rngShuffle } from '../engine';

// Monte Carlo belief core shared by COMMANDER, COMMODORE, and ADMIRAL. Pipeline per
// decision: observation → constraints → N samples → heatmap.

export interface SampleOptions {
  // Number of fleet configurations to sample.
  samples: number;
  // A MISS aged `a` is enforced with P = max(floor, 1 - a/missDecayTurns). null = all
  // evidence current (COMMANDER's blind spot; exact when movement off).
  missDecayTurns: number | null;
  // Decay floor: ships slide ≤1 cell/turn, so ancient misses stay partly valid.
  missFloor?: number;
  // Enforce no-contact ping regions as (age-discounted) ship-free.
  usePings: boolean;
  // Resampling attempts per accepted configuration before relaxing.
  maxAttempts: number;
}

interface PlacementCandidate {
  cells: number[];
}

// All legal placements per ship length, precomputed once.
const PLACEMENTS_BY_LENGTH: Record<number, PlacementCandidate[]> = {};
for (const length of [2, 3, 4, 5]) {
  const list: PlacementCandidate[] = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      if (c + length <= 10) {
        list.push({ cells: Array.from({ length }, (_, i) => r * 10 + c + i) });
      }
      if (r + length <= 10) {
        list.push({ cells: Array.from({ length }, (_, i) => (r + i) * 10 + c) });
      }
    }
  }
  PLACEMENTS_BY_LENGTH[length] = list;
}

// Every placement as a 100-bit mask in four 32-bit words, so the sampler tests a whole
// footprint with four ANDs instead of walking its cells.
const MASKS_BY_LENGTH: Record<number, Uint32Array> = {};
for (const length of [2, 3, 4, 5]) {
  const list = PLACEMENTS_BY_LENGTH[length]!;
  const masks = new Uint32Array(list.length * 4);
  list.forEach((p, i) => {
    for (const c of p.cells) masks[i * 4 + (c >>> 5)]! |= 1 << (c & 31);
  });
  MASKS_BY_LENGTH[length] = masks;
}
const MAX_PLACEMENTS = PLACEMENTS_BY_LENGTH[2]!.length;

function cellMask(cells: Iterable<number>): Uint32Array {
  const m = new Uint32Array(4);
  for (const c of cells) m[c >>> 5]! |= 1 << (c & 31);
  return m;
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Latest shot record per cell (cell-anchored markers; newest wins).
export function latestShotByCell(shots: ShotRecord[]): Map<number, ShotRecord> {
  const map = new Map<number, ShotRecord>();
  for (const s of shots) map.set(s.cell, s); // records are chronological
  return map;
}

export interface Intel {
  // Latest-record MISS cells with their age in turns.
  misses: { cell: number; age: number }[];
  // Latest-record HIT/SUNK cells (treated as ship-present; may include decoy fakes).
  hitCells: number[];
  // Age in turns of the latest HIT/SUNK record, per hit cell.
  hitAges: Record<number, number>;
  sunkKinds: ShipKind[];
  // No-contact ping regions with age.
  emptyPings: { cells: number[]; age: number }[];
  // Contact ping regions with age (weak evidence — decoys also answer).
  contactPings: { cells: number[]; age: number }[];
  // Counted sweeps (ECHO): how many cells answered, decoys included.
  countedSweeps: { cells: number[]; age: number; count: number }[];
  // Cells whose latest record exists at all (for "don't re-shoot" policies).
  shotCells: number[];
}

export function gatherIntel(obs: Observation): Intel {
  const latest = latestShotByCell(obs.myShots);
  const misses: Intel['misses'] = [];
  const hitCells: number[] = [];
  const hitAges: Record<number, number> = {};
  const shotCells: number[] = [];
  for (const [cell, record] of latest) {
    shotCells.push(cell);
    if (record.result === 'MISS') {
      misses.push({ cell, age: obs.turn - record.turn });
    } else {
      hitCells.push(cell);
      hitAges[cell] = obs.turn - record.turn;
    }
  }
  const emptyPings = obs.myPings
    .filter((p) => !p.contact)
    .map((p) => ({ cells: p.cells, age: obs.turn - p.turn }));
  const contactPings = obs.myPings
    .filter((p) => p.contact)
    .map((p) => ({ cells: p.cells, age: obs.turn - p.turn }));
  const countedSweeps = obs.myPings
    .filter((p) => p.occupancy !== undefined)
    .map((p) => ({ cells: p.cells, age: obs.turn - p.turn, count: p.occupancy! }));
  return {
    misses, hitCells, hitAges, sunkKinds: obs.enemySunk.slice(), emptyPings, contactPings,
    countedSweeps, shotCells,
  };
}

// A sonar-dredged wake, digested for the sampler: the mover is near `cells`.
export interface WakeConstraint {
  // Candidate cells: Manhattan ≤ (1 + drift) of the wake; the wake cells themselves
  // are excluded at drift 0 (the mover just left them).
  ring: Set<number>;
  // The vacated cells as revealed.
  cells: number[];
  // Global turn counter when the wake was made.
  turn: number;
  // Opponent turns elapsed since the move (0 = they moved just before us).
  drift: number;
  // Per-sample enforcement probability. Wakes are decoy-proof (decoys never move), so the
  // freshest is trusted far above a contact ping's 0.6.
  trust: number;
}

// Digest `obs.enemyWakes` into at most two constraints: the freshest (trust 0.95) and the
// one before it (0.4). Beyond drift 2 they're dropped: stale rings starve the sampler.
export function wakeConstraints(obs: Observation): WakeConstraint[] {
  if (obs.enemyWakes.length === 0) return [];
  const recent = [...obs.enemyWakes].sort((a, b) => b.turn - a.turn).slice(0, 2);
  const out: WakeConstraint[] = [];
  recent.forEach((w, i) => {
    // Drift in OPPONENT turns, not raw flips: their move at T_w, our decision
    // at T_w+1 ⇒ drift 0; each extra round trip adds 1.
    const drift = Math.max(0, Math.floor((obs.turn - w.turn - 1) / 2));
    if (drift > 2) return;
    const reach = 1 + drift;
    const wakeSet = new Set(w.cells);
    const ring = new Set<number>();
    for (let c = 0; c < 100; c++) {
      if (drift === 0 && wakeSet.has(c)) continue;
      const rc = toRC(c);
      for (const wc of w.cells) {
        const wrc = toRC(wc);
        if (Math.abs(rc.r - wrc.r) + Math.abs(rc.c - wrc.c) <= reach) {
          ring.add(c);
          break;
        }
      }
    }
    out.push({ ring, cells: w.cells, turn: w.turn, drift, trust: i === 0 ? 0.95 : 0.4 });
  });
  return out;
}

// How much the belief trusts a contact ping (decoys also answer sonar). Shared with the VoI
// scorer: a probe is only worth what its answer will be believed.
export const PING_CONTACT_TRUST = 0.6;

export interface FleetSample {
  // occupancy[cell] = 1 if an UNSUNK ship covers it in this sample.
  occupancy: Uint8Array;
}

export interface BeliefState {
  // heat[cell] ≈ P(unsunk enemy ship occupies cell), from accepted samples.
  heat: Float64Array;
  samples: FleetSample[];
}

function staleWeight(age: number, decayTurns: number | null, floor = 0): number {
  if (decayTurns === null) return 1;
  return Math.max(floor, 1 - age / decayTurns);
}

// How hard one sampling pass leans on decaying evidence (see the bankruptcy ladder in
// buildBelief).
interface Evidence {
  missFloor: number;
  missDecayTurns: number | null;
  usePings: boolean;
  useMisses: boolean;
}

// Sample fleets consistent with intel; accumulate the heatmap. Sunk ships sit entirely on
// hits; unsunk ships avoid aged misses and must cover remaining hits. Unsatisfiable
// constraints (e.g. a decoy's fake HIT) relax, not stall.
export function buildBelief(obs: Observation, opts: SampleOptions, rng: RNG): BeliefState {
  const intel = gatherIntel(obs);

  const hitSet = new Uint8Array(100);
  for (const c of intel.hitCells) hitSet[c] = 1;

  const sunkKinds = new Set(intel.sunkKinds);
  const fleetSpecs = FLEET.map((f) => ({ ...f, sunk: sunkKinds.has(f.kind) }));

  // Wake intel (decoy-proof). For the temporal unblock below we need the
  // recording turn of the evidence at each cell, not just its age.
  const wakes = wakeConstraints(obs);
  const missTurnByCell = new Map<number, number>();
  for (const m of intel.misses) missTurnByCell.set(m.cell, obs.turn - m.age);

  // A re-sweep of the same square supersedes its old answer: repeated contacts on one spot
  // are one fact, and stacked duplicates starve the sampler.
  const latestSweep = new Map<string, { cells: number[]; age: number; contact: boolean }>();
  for (const [list, contact] of [[intel.emptyPings, false], [intel.contactPings, true]] as const) {
    for (const p of list) {
      const key = p.cells.join(',');
      const prev = latestSweep.get(key);
      if (!prev || p.age < prev.age) latestSweep.set(key, { ...p, contact });
    }
  }
  const emptyPings = [...latestSweep.values()].filter((p) => !p.contact);
  // Sonar is live-only: an already-hit segment can't have answered the sweep — unless the
  // hit landed AFTER the sweep, else every kill turns its old contacts into phantom
  // constraints.
  const contactPings = [...latestSweep.values()]
    .filter((p) => p.contact)
    .map((p) => ({
      ...p,
      answerers: p.cells.filter(
        (c) => hitSet[c] === 0 || (intel.hitAges[c] ?? Infinity) <= p.age,
      ),
    }));

  const countedSweeps = intel.countedSweeps.map((p) => ({
    answerers: p.cells.filter((c) => hitSet[c] === 0 || (intel.hitAges[c] ?? Infinity) <= p.age),
    lo: Math.max(0, p.count - MAX_DECOYS),
    hi: p.count,
    age: p.age,
  }));

  const lastEmptyPingTurnByCell = new Map<number, number>();
  for (const p of emptyPings) {
    const t = obs.turn - p.age;
    for (const c of p.cells) {
      if ((lastEmptyPingTurnByCell.get(c) ?? -1) < t) lastEmptyPingTurnByCell.set(c, t);
    }
  }

  // A hit pins its ship, so a miss or clean sweep in line with the hit and OLDER than it
  // says nothing about where that ship sits now. Cells whose only blocking evidence
  // predates a nearby hit; cleared on the next-to-last attempt, before coverage is relaxed.
  const pinStale: number[] = [];
  for (let c = 0; c < 100; c++) {
    const evidenceT = Math.max(missTurnByCell.get(c) ?? -1, lastEmptyPingTurnByCell.get(c) ?? -1);
    if (evidenceT < 0 || hitSet[c] === 1) continue;
    const { r, c: col } = toRC(c);
    const pinnedAfter = intel.hitCells.some((h) => {
      const { r: hr, c: hc } = toRC(h);
      const inLine = (hr === r && Math.abs(hc - col) <= 4) || (hc === col && Math.abs(hr - r) <= 4);
      return inLine && obs.turn - (intel.hitAges[h] ?? 0) > evidenceT;
    });
    if (pinnedAfter) pinStale.push(c);
  }

  const hitM = cellMask(intel.hitCells);
  const contactMasks = new Map(contactPings.map((p) => [p, cellMask(p.answerers)]));
  const countMasks = new Map(countedSweeps.map((p) => [p, cellMask(p.answerers)]));
  const ringMasks = new Map(wakes.map((w) => [w.ring, cellMask(w.ring)]));
  const emptyPingLive = emptyPings.map((p) => p.cells.filter((c) => hitSet[c] === 0));
  // Scratch, reused by every sample: masks and the candidate index lists.
  const blockedM = new Uint32Array(4);
  const occM = new Uint32Array(4);
  const occUnsunkM = new Uint32Array(4);
  const unmetM = new Uint32Array(4);
  const openIdx = new Int32Array(MAX_PLACEMENTS);
  const viableIdx = new Int32Array(MAX_PLACEMENTS);
  const coverIdx = new Int32Array(MAX_PLACEMENTS);
  const sweepIdx = new Int32Array(MAX_PLACEMENTS);
  const loadBlocked = (blocked: Uint8Array) => {
    blockedM.fill(0);
    for (let c = 0; c < 100; c++) if (blocked[c] === 1) blockedM[c >>> 5]! |= 1 << (c & 31);
  };

  // One full sampling pass at a given strictness of the decaying evidence.
  const collect = (ev: Evidence): FleetSample[] => {
    const samples: FleetSample[] = [];
    for (let s = 0; s < opts.samples; s++) {
      // Stale evidence enforced probabilistically per sample = decay toward uninformative.
      const blocked = new Uint8Array(100);
      const floor = ev.missFloor;
      if (ev.useMisses) {
        for (const m of intel.misses) {
          if (rng() < staleWeight(m.age, ev.missDecayTurns, floor)) blocked[m.cell] = 1;
        }
      }
      const pingBlocked: number[][] = [];
      const mustContain: Uint32Array[] = [];
      const mustCount: { mask: Uint32Array; lo: number; hi: number }[] = [];
      if (ev.usePings) {
        emptyPings.forEach((p, i) => {
          if (rng() < staleWeight(p.age, ev.missDecayTurns ?? 6, floor)) pingBlocked.push(emptyPingLive[i]!);
        });
        // Contact pings are weak evidence (decoys also answer): age-discounted trust.
        for (const p of contactPings) {
          if (rng() < PING_CONTACT_TRUST * staleWeight(p.age, ev.missDecayTurns ?? 6, floor)) {
            mustContain.push(contactMasks.get(p)!);
          }
        }
        // A count is decoy-proof as a range: live ship cells lie in [count - MAX_DECOYS, count].
        for (const p of countedSweeps) {
          if (rng() < staleWeight(p.age, ev.missDecayTurns ?? 6, floor)) {
            mustCount.push({ mask: countMasks.get(p)!, lo: p.lo, hi: p.hi });
          }
        }
      }
      for (const region of pingBlocked) for (const c of region) blocked[c] = 1;

      // Enforced wakes: the mover must sit in the ring, and the move proves ring cells were
      // enterable after older evidence — unblock those, or stale misses starve the pool.
      // Evidence recorded AFTER the wake still binds.
      const mustBeNear: Uint32Array[] = [];
      for (const w of wakes) {
        if (rng() >= w.trust) continue;
        mustBeNear.push(ringMasks.get(w.ring)!);
        for (const c of w.ring) {
          const missT = missTurnByCell.get(c);
          const pingT = lastEmptyPingTurnByCell.get(c);
          if ((missT === undefined || missT < w.turn) && (pingT === undefined || pingT < w.turn)) {
            blocked[c] = 0;
          }
        }
        // The mover cannot still occupy its just-vacated cells.
        if (w.drift === 0) for (const c of w.cells) blocked[c] = 1;
      }

      // Placed ships as (length, placement index, sunk) triples; null until a fleet fits.
      let accepted: number[] | null = null;
      loadBlocked(blocked);

      for (let attempt = 0; attempt < opts.maxAttempts && !accepted; attempt++) {
        const relaxCoverage = attempt === opts.maxAttempts - 1;
        if (attempt === opts.maxAttempts - 2 && pinStale.length > 0) {
          for (const c of pinStale) blocked[c] = 0;
          loadBlocked(blocked);
        }
        occM.fill(0);
        occUnsunkM.fill(0);
        const placed: number[] = [];
        let failed = false;

        // Sunk ships first (hardest constraint), then the rest, shuffled.
        const order = [
          ...rngShuffle(rng, fleetSpecs.filter((f) => f.sunk)),
          ...rngShuffle(rng, fleetSpecs.filter((f) => !f.sunk)),
        ];

        for (const spec of order) {
          const n = PLACEMENTS_BY_LENGTH[spec.length]!.length;
          const M = MASKS_BY_LENGTH[spec.length]!;
          const [o0, o1, o2, o3] = occM as unknown as [number, number, number, number];
          let pool = openIdx;
          let poolLen = 0;
          if (spec.sunk) {
            // Every cell of a sunk wreck is a recorded hit.
            for (let i = 0; i < n; i++) {
              const b = i * 4;
              if (((M[b]! & (~hitM[0]! | o0)) | (M[b + 1]! & (~hitM[1]! | o1)) |
                (M[b + 2]! & (~hitM[2]! | o2)) | (M[b + 3]! & (~hitM[3]! | o3))) === 0) openIdx[poolLen++] = i;
            }
            if (poolLen === 0 && relaxCoverage) {
              for (let i = 0; i < n; i++) {
                const b = i * 4;
                if (((M[b]! & o0) | (M[b + 1]! & o1) | (M[b + 2]! & o2) | (M[b + 3]! & o3)) === 0) {
                  openIdx[poolLen++] = i;
                }
              }
            }
          } else {
            const x0 = blockedM[0]! | o0, x1 = blockedM[1]! | o1;
            const x2 = blockedM[2]! | o2, x3 = blockedM[3]! | o3;
            // Outstanding hits: hit cells no placed ship covers yet.
            const u0 = hitM[0]! & ~o0, u1 = hitM[1]! & ~o1, u2 = hitM[2]! & ~o2, u3 = hitM[3]! & ~o3;
            const anyUncovered = (u0 | u1 | u2 | u3) !== 0;
            let nOpen = 0, nViable = 0, nCover = 0;
            for (let i = 0; i < n; i++) {
              const b = i * 4;
              const m0 = M[b]!, m1 = M[b + 1]!, m2 = M[b + 2]!, m3 = M[b + 3]!;
              if (((m0 & x0) | (m1 & x1) | (m2 & x2) | (m3 & x3)) !== 0) continue;
              openIdx[nOpen++] = i;
              // An unsunk ship can't be fully hit; prefer covering outstanding hits.
              if (((m0 & ~hitM[0]!) | (m1 & ~hitM[1]!) | (m2 & ~hitM[2]!) | (m3 & ~hitM[3]!)) === 0) continue;
              viableIdx[nViable++] = i;
              if (anyUncovered && ((m0 & u0) | (m1 & u1) | (m2 & u2) | (m3 & u3)) !== 0) coverIdx[nCover++] = i;
            }
            // Hits covered, aim at an unexplained contact sweep the same way — blind
            // placement then rejection almost never satisfies several sweeps at once.
            let nSweep = 0;
            if (nCover === 0 && mustContain.length > 0) {
              unmetM.fill(0);
              for (const a of mustContain) {
                if (((a[0]! & o0) | (a[1]! & o1) | (a[2]! & o2) | (a[3]! & o3)) !== 0) continue;
                for (let w = 0; w < 4; w++) unmetM[w]! |= a[w]!;
              }
              if ((unmetM[0]! | unmetM[1]! | unmetM[2]! | unmetM[3]!) !== 0) {
                for (let j = 0; j < nViable; j++) {
                  const b = viableIdx[j]! * 4;
                  if (((M[b]! & unmetM[0]!) | (M[b + 1]! & unmetM[1]!) | (M[b + 2]! & unmetM[2]!) |
                    (M[b + 3]! & unmetM[3]!)) !== 0) sweepIdx[nSweep++] = viableIdx[j]!;
                }
              }
            }
            if (nCover > 0) [pool, poolLen] = [coverIdx, nCover];
            else if (nSweep > 0) [pool, poolLen] = [sweepIdx, nSweep];
            else if (nViable > 0) [pool, poolLen] = [viableIdx, nViable];
            else [pool, poolLen] = [openIdx, nOpen];
          }
          if (poolLen === 0) {
            failed = true;
            break;
          }
          const idx = pool[rngInt(rng, poolLen)]!;
          const b = idx * 4;
          for (let w = 0; w < 4; w++) {
            occM[w]! |= M[b + w]!;
            if (!spec.sunk) occUnsunkM[w]! |= M[b + w]!;
          }
          placed.push(spec.length, idx, spec.sunk ? 1 : 0);
        }

        if (failed) continue;
        if (!relaxCoverage) {
          if (((hitM[0]! & ~occM[0]!) | (hitM[1]! & ~occM[1]!) | (hitM[2]! & ~occM[2]!) |
            (hitM[3]! & ~occM[3]!)) !== 0) continue;
          if (mustContain.some((a) =>
            ((a[0]! & occM[0]!) | (a[1]! & occM[1]!) | (a[2]! & occM[2]!) | (a[3]! & occM[3]!)) === 0)) {
            continue;
          }
          if (mustCount.some(({ mask: a, lo, hi }) => {
            const n = popcount32(a[0]! & occUnsunkM[0]!) + popcount32(a[1]! & occUnsunkM[1]!) +
              popcount32(a[2]! & occUnsunkM[2]!) + popcount32(a[3]! & occUnsunkM[3]!);
            return n < lo || n > hi;
          })) {
            continue;
          }
          // Wake rings: only an UNSUNK ship can explain a wake (wrecks don't move).
          if (mustBeNear.some((a) => ((a[0]! & occUnsunkM[0]!) | (a[1]! & occUnsunkM[1]!) |
            (a[2]! & occUnsunkM[2]!) | (a[3]! & occUnsunkM[3]!)) === 0)) {
            continue;
          }
        }
        accepted = placed;
      }

      if (!accepted) continue; // give up on this sample entirely (very rare)

      const occupancy = new Uint8Array(100);
      for (let t = 0; t < accepted.length; t += 3) {
        if (accepted[t + 2] === 1) continue;
        for (const c of PLACEMENTS_BY_LENGTH[accepted[t]!]![accepted[t + 1]!]!.cells) occupancy[c] = 1;
      }
      samples.push({ occupancy });
    }
    return samples;
  };

  // Evidence bankruptcy ladder: if no fleet fits, the ships moved, so yield the miss floor,
  // then misses and pings entirely. Hits and wrecks, which movement can't invalidate, bind.
  const strict: Evidence = {
    missFloor: opts.missFloor ?? 0,
    missDecayTurns: opts.missDecayTurns,
    usePings: opts.usePings,
    useMisses: true,
  };
  let samples = collect(strict);
  if (samples.length === 0) {
    samples = collect({ ...strict, missFloor: 0, missDecayTurns: opts.missDecayTurns ?? 6 });
  }
  if (samples.length === 0) samples = collect({ ...strict, useMisses: false, usePings: false });

  const heat = new Float64Array(100);
  for (const sample of samples) {
    for (let c = 0; c < 100; c++) if (sample.occupancy[c] === 1) heat[c]!++;
  }
  if (samples.length > 0) {
    for (let c = 0; c < 100; c++) heat[c] = heat[c]! / samples.length;
  }
  return { heat, samples };
}

// Argmax over cells with rng tie-breaking; `exclude` cells are skipped.
export function hottestCell(heat: Float64Array, exclude: Set<number>, rng: RNG): number | null {
  let best = -1;
  const ties: number[] = [];
  for (let c = 0; c < 100; c++) {
    if (exclude.has(c)) continue;
    if (heat[c]! > best + 1e-12) {
      best = heat[c]!;
      ties.length = 0;
      ties.push(c);
    } else if (Math.abs(heat[c]! - best) <= 1e-12) {
      ties.push(c);
    }
  }
  if (ties.length === 0) return null;
  return ties[rngInt(rng, ties.length)]!;
}

// Max heat over non-excluded cells (the value counterpart of hottestCell).
export function bestHeat(heat: Float64Array, exclude: Set<number>): number {
  let best = 0;
  for (let c = 0; c < 100; c++) {
    if (!exclude.has(c) && heat[c]! > best) best = heat[c]!;
  }
  return best;
}

// Expected best shootable heat AFTER a binary answer (samples split by `isContact`, each
// branch's max weighted by its probability); the surplus over `priorBest` is the probe's
// value. Branches thinner than `minBranchSamples` shrink toward `priorBest`.
function splitValue(
  belief: BeliefState,
  isContact: (occ: Uint8Array) => boolean,
  exclude: Set<number>,
  minBranchSamples: number,
  priorBest: number,
  extraExclude?: number,
): number {
  const { p, h1, h0 } = splitValueBranches(belief, isContact, exclude, minBranchSamples, priorBest, extraExclude);
  return p * h1 + (1 - p) * h0;
}

// The split's raw ingredients: P(contact) and each branch's (shrunk) best heat.
function splitValueBranches(
  belief: BeliefState,
  isContact: (occ: Uint8Array) => boolean,
  exclude: Set<number>,
  minBranchSamples: number,
  priorBest: number,
  extraExclude?: number,
): { p: number; h1: number; h0: number } {
  const n = belief.samples.length;
  if (n === 0) return { p: 0.5, h1: priorBest, h0: priorBest };

  const contact = new Uint8Array(n);
  let n1 = 0;
  belief.samples.forEach((s, i) => {
    if (isContact(s.occupancy)) {
      contact[i] = 1;
      n1++;
    }
  });
  const n0 = n - n1;

  // Accumulate only the smaller branch; recover the other from the heatmap
  // totals (heat[c]·n is the all-samples count).
  const small = n1 <= n0 ? 1 : 0;
  const counts = new Float64Array(100);
  belief.samples.forEach((s, i) => {
    if (contact[i] !== small) return;
    const occ = s.occupancy;
    for (let c = 0; c < 100; c++) if (occ[c] === 1) counts[c]!++;
  });

  let h1 = 0;
  let h0 = 0;
  for (let c = 0; c < 100; c++) {
    if (exclude.has(c) || c === extraExclude) continue;
    const total = belief.heat[c]! * n;
    const inSmall = counts[c]!;
    const c1 = small === 1 ? inSmall : total - inSmall;
    const c0 = total - c1;
    if (n1 > 0 && c1 / n1 > h1) h1 = c1 / n1;
    if (n0 > 0 && c0 / n0 > h0) h0 = c0 / n0;
  }
  const w1 = Math.min(1, n1 / minBranchSamples);
  const w0 = Math.min(1, n0 / minBranchSamples);
  return {
    p: n1 / n,
    h1: w1 * h1 + (1 - w1) * priorBest,
    h0: w0 * h0 + (1 - w0) * priorBest,
  };
}

// splitValue for a PING at `center` (pass known hits as `excludeHits`; sonar is live-only).
// Contact is priced at PING_CONTACT_TRUST, as buildBelief discounts it; pricing the full
// split makes a VoI bot re-buy the same contact forever.
export function pingSplitValue(
  belief: BeliefState,
  center: number,
  exclude: Set<number>,
  minBranchSamples: number,
  priorBest: number,
  excludeHits?: Set<number>,
): number {
  const region = pingCells(center).filter((c) => !excludeHits?.has(c));
  if (region.length === 0) return priorBest;
  const raw = splitValueBranches(
    belief,
    (occ) => region.some((c) => occ[c] === 1),
    exclude,
    minBranchSamples,
    priorBest,
  );
  const realizedContact = PING_CONTACT_TRUST * raw.h1 + (1 - PING_CONTACT_TRUST) * priorBest;
  return raw.p * realizedContact + (1 - raw.p) * raw.h0;
}

// splitValue for a FIRE at `cell` (a shot is also a 1-cell sensor). The target itself is
// excluded from the posterior max — once shot, it's spent.
export function shotSplitValue(
  belief: BeliefState,
  cell: number,
  exclude: Set<number>,
  minBranchSamples: number,
  priorBest: number,
): number {
  return splitValue(belief, (occ) => occ[cell] === 1, exclude, minBranchSamples, priorBest, cell);
}

// P(ping at `center` reports contact) over the sampled belief (unsunk ships only). Pass the
// known hit cells as `excludeHits`: damaged segments don't answer, so they can't produce a
// contact.
export function pingContactProbability(
  belief: BeliefState,
  center: number,
  excludeHits?: Set<number>,
): number {
  if (belief.samples.length === 0) return 0.5;
  const region = pingCells(center).filter((c) => !excludeHits?.has(c));
  let contacts = 0;
  for (const sample of belief.samples) {
    if (region.some((c) => sample.occupancy[c] === 1)) contacts++;
  }
  return contacts / belief.samples.length;
}
