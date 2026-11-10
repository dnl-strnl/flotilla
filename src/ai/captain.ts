import { AP_COST, encodeAction, type Action, type Observation, type RNG } from '../engine';
import { hottestCell, type BeliefState } from './montecarlo';
import {
  buildShotExclusions,
  pickDecoy,
  pickEntropyPing,
  pickFinishingShot,
  sonarSpend,
} from './commodore';
import {
  anyMoveLegal,
  fireAnywhere,
  meanPositiveHeat,
  pickEvasiveMove,
  targetBelief,
  threatBelief,
} from './kit';
import type { Bot } from './types';

export interface CaptainTuning {
  // Monte Carlo fleet samples per decision (makeCaptain can override).
  samples: number;
  // Belief options, same semantics as COMMODORE's.
  missDecayTurns: number;
  missFloor: number;
  unresolvedHitProb: number;
  // Finish wounded hulls along the axis two collinear hits imply (see COMMODORE's knob).
  axisLock: boolean;
  // The late switch: from this turn on, CAPTAIN stops hiding and hunts (without it, it runs
  // the clock to a draw).
  lateTurn: number;
  // …and the same switch on the other trigger: enemy nearly dead, go finish it.
  triageAtEnemyShips: number;
  // Shoot only when the argmax stands this far above mean positive heat; below the bar the
  // AP buys hull safety instead.
  strongTargetRatio: number;
  // Decoys go out EARLY and BOTH of them — bait before being found.
  decoyEarliestTurn: number;
  decoyLatestTurn: number;
  secondDecoyAfterLosses: number;
  decoySamples: number;
  decoyHeatWeight: number;
  decoyDistanceWeight: number;
  // 0 = never hold for a focused enemy search; get the bait in the water.
  decoyMinHeatRatio: number;
  // A ship is endangered within this Chebyshev radius of…
  dangerRadius: number;
  // …an enemy shot in the last N turns; endangered hulls move first.
  dangerWindow: number;
  endangeredBonus: number;
  // Minimum exposure drop for an evasive MOVE (deliberately low: CAPTAIN slides on thin
  // margins).
  defEpsilon: number;
  // MC samples for the opponent-belief (threat) model behind evasion.
  threatSamples: number;
  // Penalty per vacated (wake) cell (a sideways step leaks the whole footprint, an
  // along-axis step one cell).
  wakeLeakWeight: number;
  // Shot bookkeeping, same semantics as COMMODORE's.
  shotRepeatWindow: number;
  reshootHitAfter: number;
  // Leftover-AP sonar.
  pingMinScore: number;
  pingRepeatWindow: number;
  wakeSniffMinHeat: number;
}

// Every CAPTAIN heuristic constant lives here. Tune freely.
const CAPTAIN_TUNING: CaptainTuning = {
  samples: 1000,
  missDecayTurns: 6,
  missFloor: 0.85,
  unresolvedHitProb: 0.5,
  axisLock: true,
  lateTurn: 70,
  triageAtEnemyShips: 2,
  strongTargetRatio: 1.6,
  decoyEarliestTurn: 1,
  decoyLatestTurn: 16,
  secondDecoyAfterLosses: 1,
  decoySamples: 300,
  decoyHeatWeight: 3,
  decoyDistanceWeight: 1,
  decoyMinHeatRatio: 0,
  dangerRadius: 1,
  dangerWindow: 2,
  endangeredBonus: 0.08,
  defEpsilon: 0.015,
  threatSamples: 200,
  wakeLeakWeight: 0.01,
  shotRepeatWindow: 8,
  reshootHitAfter: 12,
  pingMinScore: 0.18,
  pingRepeatWindow: 5,
  wakeSniffMinHeat: 0.01,
};

type Tuning = CaptainTuning;

// Memo key for the threat build: our hulls and the shells against us. Several micro-actions
// per turn share one position.
function threatKey(obs: Observation): string {
  const hulls = obs.myShips
    .map((s) => `${s.origin}${s.orient}${s.sunk ? 'x' : ''}${s.hits.reduce((n, h) => n + (h ? 1 : 0), 0)}`)
    .join('.');
  const last = obs.shotsAgainstMe[obs.shotsAgainstMe.length - 1];
  return `${obs.turn}|${obs.shotsAgainstMe.length}|${last?.cell ?? -1}|${hulls}|${obs.myDecoysLeft}`;
}

// CAPTAIN — the ghost. Early: both decoys out, hulls sliding off threatened squares, shells
// only at wounded ships or standout targets. After lateTurn (or enemy near dead) it hunts
// with every AP.
export function makeCaptain(samples = CAPTAIN_TUNING.samples, tuning: Tuning = CAPTAIN_TUNING): Bot {
  let cacheKey = '';
  let cached: BeliefState | null = null;
  const threatFor = (obs: Observation, rng: RNG): BeliefState => {
    const key = threatKey(obs);
    if (key !== cacheKey || cached === null) {
      cached = threatBelief(obs, tuning.threatSamples, rng);
      cacheKey = key;
    }
    return cached;
  };
  return (obs, legal, rng) => {
    const legalSet = new Set(legal);
    if (legalSet.size <= 1) return { type: 'PASS' };

    const belief = targetBelief(obs, samples, obs.config.movement ? tuning.missDecayTurns : null, tuning.missFloor, rng);

    // Wounded enemy hulls are free damage in either mode — never walk past one.
    if (obs.ap >= AP_COST.FIRE) {
      const finishing = pickFinishingShot(obs, belief, legalSet, tuning, rng);
      if (finishing) return finishing;
    }

    const hunting =
      obs.turn >= tuning.lateTurn || obs.enemyShipsRemaining <= tuning.triageAtEnemyShips;
    const exclude = buildShotExclusions(obs, tuning);
    const target = hottestCell(belief.heat, exclude, rng);

    if (!hunting) {
      // 1. Bait first, always.
      const decoy = pickDecoy(obs, legalSet, tuning, rng);
      if (decoy) return decoy;

      // 2. Then hull safety, once they've fired (before that their belief is flat).
      if (obs.shotsAgainstMe.length > 0 && anyMoveLegal(legalSet) && obs.ap >= AP_COST.MOVE) {
        const evade = pickEvasiveMove(obs, threatFor(obs, rng), legalSet, tuning, rng);
        if (evade) return evade.action;
      }

      // 3. Shells only at a target that stands clear of the pack.
      const meanHeat = meanPositiveHeat(belief.heat);
      const strong =
        target !== null &&
        meanHeat > 0 &&
        (belief.heat[target] ?? 0) >= tuning.strongTargetRatio * meanHeat;
      if (obs.ap >= AP_COST.FIRE && strong && legalSet.has(encodeAction({ type: 'FIRE', cell: target }))) {
        return { type: 'FIRE', cell: target };
      }

      // 4. Otherwise the point buys sonar rather than a speculative shell.
      const ping = pickEntropyPing(obs, belief, legalSet, tuning, rng);
      if (ping) return ping;
    }

    // Odd leftover AP can't buy a shell: dredge a fresh wake, else sweep.
    if (obs.ap % 2 === 1) {
      const spare = sonarSpend(obs, belief, legalSet, tuning, rng, true, () =>
        pickEntropyPing(obs, belief, legalSet, tuning, rng));
      if (spare) return spare;
    }

    if (obs.ap >= AP_COST.FIRE && target !== null) {
      const action: Action = { type: 'FIRE', cell: target };
      if (legalSet.has(encodeAction(action))) return action;
    }

    return fireAnywhere(obs, belief, legalSet, rng) ?? { type: 'PASS' };
  };
}
