import { AP_COST, encodeAction, toRC, type Action, type Observation, type RNG } from '../engine';
import { bestHeat, gatherIntel, pingSplitValue, shotSplitValue, type BeliefState } from './montecarlo';
import { buildShotExclusions, pickDecoy, pickFinishingShot, sonarSpend } from './commodore';
import { fireAnywhere, pickEvasiveMove, targetBelief, threatBelief } from './kit';
import type { Bot } from './types';

export interface AdmiralTuning {
  // Monte Carlo fleet samples per decision (makeAdmiral can override).
  samples: number;
  // Belief options, same semantics as COMMODORE's.
  missDecayTurns: number;
  missFloor: number;
  unresolvedHitProb: number;
  // Finish wounded hulls along the axis two collinear hits imply (see COMMODORE's knob).
  axisLock: boolean;
  // Reused COMMODORE kit knobs (decoy siting, triage, wake sniff, exclusions).
  dangerRadius: number;
  dangerWindow: number;
  decoyEarliestTurn: number;
  decoyLatestTurn: number;
  secondDecoyAfterLosses: number;
  triageAtEnemyShips: number;
  wakeSniffMinHeat: number;
  decoySamples: number;
  decoyHeatWeight: number;
  decoyDistanceWeight: number;
  decoyMinHeatRatio: number;
  shotRepeatWindow: number;
  reshootHitAfter: number;
  // VoI economy: a ping's posterior sharpening benefits roughly this many future shots. The
  // ping fires when voiHorizon·voi/1AP beats h0/2AP.
  voiHorizon: number;
  // Defensive economy: an exposure drop shields against roughly this many incoming shots.
  // The move fires when defenseHorizon·defVoi/AP_COST.MOVE wins.
  defenseHorizon: number;
  // Minimum exposure drop for a MOVE to be considered at all (kills shuffling).
  defEpsilon: number;
  // λ on a shot's own split value — a shot is also a 1-cell sensor.
  shotInfoWeight: number;
  // Only the top-K heat cells get the (costly) shot split term.
  shotInfoTopK: number;
  // Minimum VoI for a ping to be considered at all.
  voiEpsilon: number;
  // Branches thinner than this shrink toward the prior best (noise guard).
  minBranchSamples: number;
  // Turns for an answered sweep to become worth re-buying as the fleet drifts. Without it,
  // the trust-discounted split still looks open and the same center is re-picked.
  pingRefreshTurns: number;
  // MC samples for the opponent-belief (threat) model behind defensive moves.
  threatSamples: number;
  // Small additive defense bonus for ships near recent enemy shots.
  endangeredBonus: number;
}

// Every ADMIRAL heuristic constant lives here. Tune freely.
export const ADMIRAL_TUNING: AdmiralTuning = {
  samples: 1000,
  missDecayTurns: 6,
  missFloor: 0.85,
  unresolvedHitProb: 0.5,
  axisLock: true,
  dangerRadius: 1,
  dangerWindow: 2,
  decoyEarliestTurn: 3,
  decoyLatestTurn: 16,
  secondDecoyAfterLosses: 2,
  triageAtEnemyShips: 2,
  wakeSniffMinHeat: 0.01,
  decoySamples: 300,
  decoyHeatWeight: 3,
  decoyDistanceWeight: 1,
  decoyMinHeatRatio: 1.5,
  shotRepeatWindow: 8,
  reshootHitAfter: 12,
  // Kept low: miss decay leaves phantom splits (voi ≳ 0.04), so a longer horizon pings
  // forever.
  voiHorizon: 2,
  defenseHorizon: 3,
  defEpsilon: 0.02,
  shotInfoWeight: 0.3,
  shotInfoTopK: 12,
  voiEpsilon: 0.02,
  minBranchSamples: 25,
  pingRefreshTurns: 4,
  threatSamples: 300,
  endangeredBonus: 0.05,
};

type Tuning = AdmiralTuning;

// Best ping by posterior sample-split VoI. No repeat window: a settled region prices itself
// out (voi ≈ 0); recently swept centers are discounted by freshness instead.
function pickVoiPing(
  obs: Observation,
  belief: BeliefState,
  legalSet: Set<number>,
  exclude: Set<number>,
  h0: number,
  t: Tuning,
  rng: RNG,
): { action: Action; voi: number } | null {
  if (!obs.config.pings || obs.ap < obs.pingCost) return null;
  const excludeHits = new Set(gatherIntel(obs).hitCells);

  // Freshest sweep age per center, for the already-asked discount below.
  const sweptAge = new Map<number, number>();
  for (const p of obs.myPings) {
    const age = obs.turn - p.turn;
    if (age < (sweptAge.get(p.center) ?? Infinity)) sweptAge.set(p.center, age);
  }
  // 0 = we just asked this and hold the answer; 1 = fully worth re-buying.
  const freshness = (center: number): number => {
    if (sweptAge.size === 0) return 1;
    const { r, c } = toRC(center);
    let factor = 1;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr > 9 || nc < 0 || nc > 9) continue;
        const age = sweptAge.get(nr * 10 + nc);
        if (age === undefined) continue;
        // A neighbouring 3×3 shares 6 of 9 cells; the answer regains value as ships drift.
        const overlap = dr === 0 && dc === 0 ? 1 : 2 / 3;
        const recovered = Math.min(1, age / t.pingRefreshTurns);
        factor = Math.min(factor, 1 - overlap * (1 - recovered));
      }
    }
    return factor;
  };

  let best: number | null = null;
  let bestVoi = t.voiEpsilon;
  for (let center = 0; center < 100; center++) {
    if (!legalSet.has(encodeAction({ type: 'PING', center }))) continue;
    const fresh = freshness(center);
    if (fresh <= 0) continue;
    const posterior = pingSplitValue(belief, center, exclude, t.minBranchSamples, h0, excludeHits);
    const voi = (posterior - h0) * fresh + rng() * 1e-4;
    if (voi > bestVoi) {
      bestVoi = voi;
      best = center;
    }
  }
  return best === null ? null : { action: { type: 'PING', center: best }, voi: bestVoi };
}

// ADMIRAL — COMMODORE's kit, but every spend is priced in damage-equivalents per AP: shoot
// (h0/2), ping (voiHorizon·voi, the expected best-shot improvement), or move
// (defenseHorizon·exposure drop). Scouts to converge, hides to survive, then strikes.
export function makeAdmiral(
  samples = ADMIRAL_TUNING.samples,
  tuning: Tuning = ADMIRAL_TUNING,
): Bot {
  return (obs, legal, rng) => {
    const legalSet = new Set(legal);
    if (legalSet.size <= 1) return { type: 'PASS' };

    const belief = targetBelief(obs, samples, obs.config.movement ? tuning.missDecayTurns : null, tuning.missFloor, rng);

    const triage = obs.enemyShipsRemaining <= tuning.triageAtEnemyShips;

    if (obs.ap >= AP_COST.FIRE) {
      const finishing = pickFinishingShot(obs, belief, legalSet, tuning, rng);
      if (finishing) return finishing;
    }

    const exclude = buildShotExclusions(obs, tuning);
    const h0 = bestHeat(belief.heat, exclude);

    // Same triage rule as COMMODORE: the odd point goes to sonar (fresh wake first). No
    // economy bar here: the AP is free.
    if (triage && obs.ap % 2 === 1) {
      const spare = sonarSpend(obs, belief, legalSet, tuning, rng, true, () =>
        pickVoiPing(obs, belief, legalSet, exclude, h0, tuning, rng)?.action ?? null);
      if (spare) return spare;
    }

    if (!triage) {
      const decoy = pickDecoy(obs, legalSet, tuning, rng);
      if (decoy) return decoy;
    }

    // Unified economy: price each spend in damage-equivalents per AP.
    if (!triage) {
      const ping = pickVoiPing(obs, belief, legalSet, exclude, h0, tuning, rng);
      // Priced off what the NEXT sweep costs (pingEscalates doubles a turn's second sweep).
      const pingRate = ping ? (tuning.voiHorizon * ping.voi) / obs.pingCost : -Infinity;

      // Before they've fired their belief is flat: no exposure to shed, so skip the build.
      const move =
        obs.config.movement && obs.ap >= AP_COST.MOVE && obs.shotsAgainstMe.length > 0
          ? pickEvasiveMove(obs, threatBelief(obs, tuning.threatSamples, rng), legalSet, tuning, rng)
          : null;
      const moveRate = move ? (tuning.defenseHorizon * move.def) / AP_COST.MOVE : -Infinity;

      const shootRate = obs.ap >= AP_COST.FIRE ? h0 / AP_COST.FIRE : -Infinity;

      // A ping that strands the turn's last shot costs the whole shot, not half of one.
      const displacesShot =
        Math.floor((obs.ap - obs.pingCost) / AP_COST.FIRE) < Math.floor(obs.ap / AP_COST.FIRE);
      const pingBeatsShot = ping
        ? displacesShot
          ? tuning.voiHorizon * ping.voi > h0
          : pingRate > shootRate
        : false;

      if (pingBeatsShot && pingRate >= moveRate && ping) return ping.action;
      if (moveRate > shootRate && move) return move.action;
    }

    // Strike: hottest cells, nudged by what a miss would still teach us.
    if (obs.ap >= AP_COST.FIRE) {
      // Random jitter breaks ties; a stable sort would aim a flat belief at cells 0..K-1.
      const candidates: { cell: number; heat: number; jitter: number }[] = [];
      for (let cell = 0; cell < 100; cell++) {
        if (exclude.has(cell)) continue;
        if (!legalSet.has(encodeAction({ type: 'FIRE', cell }))) continue;
        candidates.push({ cell, heat: belief.heat[cell] ?? 0, jitter: rng() });
      }
      candidates.sort((a, b) => b.heat - a.heat || a.jitter - b.jitter);
      let best: number | null = null;
      let bestScore = -Infinity;
      for (const { cell, heat } of candidates.slice(0, tuning.shotInfoTopK)) {
        const info = shotSplitValue(belief, cell, exclude, tuning.minBranchSamples, h0) - h0;
        const score = heat + tuning.shotInfoWeight * Math.max(0, info) + rng() * 1e-4;
        if (score > bestScore) {
          bestScore = score;
          best = cell;
        }
      }
      if (best !== null) return { type: 'FIRE', cell: best };
    }

    return fireAnywhere(obs, belief, legalSet, rng) ?? { type: 'PASS' };
  };
}
