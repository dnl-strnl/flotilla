import {
  AP_COST,
  AP_CAP,
  AP_FLOOR,
  FLEET,
  encodeAction,
  rngInt,
  type Action,
  type Observation,
} from '../engine';
import { bestHeat, gatherIntel, hottestCell } from './montecarlo';
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

export interface LieutenantTuning {
  // Monte Carlo fleet samples per decision (makeLieutenant can override).
  samples: number;
  // Belief decay once the opponent reads as a DODGER.
  dodgerMissDecayTurns: number;
  missFloor: number;
  unresolvedHitProb: number;
  // Finish wounded hulls along the axis two collinear hits imply (see COMMODORE's knob).
  axisLock: boolean;
  // Rolling window, in global turns, for the AP-spend profile.
  profileWindow: number;
  // Share of their AP going to shells that reads as HUNTER.
  hunterShellShare: number;
  // Their turns we must have watched before a STATIC read is allowed at all.
  staticMinTurns: number;
  // Shot bookkeeping under a DODGER read (misses expire, stale hits re-open).
  dodgerShotRepeatWindow: number;
  dodgerReshootHitAfter: number;
  // Under a STATIC read nothing ever un-resolves: shoot each cell once.
  staticShotRepeatWindow: number;
  staticReshootHitAfter: number;
  // The sniper gate, absolute floor: below this best-shot probability a shell is never
  // worth firing.
  sniperMinHeat: number;
  // The sniper gate, relative bar: fire only when the best cell stands this far above mean
  // positive heat (refuses the tepid early shots an absolute bar lets through).
  sniperStrongRatio: number;
  // Hard cap on gate-bought sweeps per turn (leftover-AP sonar is extra).
  gatePingsPerTurn: number;
  // Counter-hunter spending, used only under a HUNTER read.
  decoyEarliestTurn: number;
  decoyLatestTurn: number;
  secondDecoyAfterLosses: number;
  decoySamples: number;
  decoyHeatWeight: number;
  decoyDistanceWeight: number;
  decoyMinHeatRatio: number;
  threatSamples: number;
  defEpsilon: number;
  dangerRadius: number;
  dangerWindow: number;
  endangeredBonus: number;
  wakeLeakWeight: number;
  // Leftover-AP sonar.
  pingMinScore: number;
  pingRepeatWindow: number;
  wakeSniffMinHeat: number;
  triageAtEnemyShips: number;
}

// Every LIEUTENANT heuristic constant lives here. Tune freely.
export const LIEUTENANT_TUNING: LieutenantTuning = {
  samples: 1000,
  dodgerMissDecayTurns: 6,
  missFloor: 0.85,
  unresolvedHitProb: 0.5,
  axisLock: true,
  profileWindow: 16,
  hunterShellShare: 0.85,
  staticMinTurns: 10,
  dodgerShotRepeatWindow: 8,
  dodgerReshootHitAfter: 12,
  staticShotRepeatWindow: 999,
  staticReshootHitAfter: 999,
  sniperMinHeat: 0.12,
  sniperStrongRatio: 1.4,
  gatePingsPerTurn: 2,
  decoyEarliestTurn: 3,
  decoyLatestTurn: 20,
  secondDecoyAfterLosses: 2,
  decoySamples: 300,
  decoyHeatWeight: 3,
  decoyDistanceWeight: 1,
  decoyMinHeatRatio: 1.2,
  threatSamples: 300,
  defEpsilon: 0.05,
  dangerRadius: 1,
  dangerWindow: 2,
  endangeredBonus: 0.05,
  wakeLeakWeight: 0.01,
  pingMinScore: 0.18,
  pingRepeatWindow: 5,
  wakeSniffMinHeat: 0.01,
  triageAtEnemyShips: 2,
};

type Tuning = LieutenantTuning;

// What LIEUTENANT thinks it is playing against, from the redacted view alone.
export interface OpponentProfile {
  // Shot-result flips at a single cell (MISS→HIT, HIT→MISS): each one is a hull that slid,
  // a decoy that died, or both. Movement's fingerprint.
  flips: number;
  // Enemy wakes we have actually dredged up with sonar.
  wakes: number;
  // Share of their recent AP that came back at us as shells, 0..1.
  shellShare: number;
  // They move: trust aged intel less, re-open resolved water, sniff wakes.
  dodging: boolean;
  // They spend everything on shells and it is landing: buy hull safety.
  hunting: boolean;
  // The fleet read: still or sliding? Orthogonal to `hunting` on purpose.
  read: 'STATIC' | 'DODGER';
}

// Count cells whose reported result has changed across our own shot history.
function countFlips(obs: Observation): number {
  const last = new Map<number, 'HIT' | 'MISS'>();
  let flips = 0;
  for (const s of obs.myShots) {
    const now = s.result === 'MISS' ? 'MISS' : 'HIT';
    const before = last.get(s.cell);
    if (before !== undefined && before !== now) flips++;
    last.set(s.cell, now);
  }
  return flips;
}

// AP forensics: their past budgets are reconstructible from when we sank their ships, and
// their shells are visible. Returns their turns observed and how many left a MOVE's worth
// of AP unaccounted for; one such turn disqualifies the STATIC read for good.
export function apForensics(obs: Observation, moveCost: number): { turns: number; slackTurns: number } {
  const sunkByTurn = obs.myShots
    .filter((s) => s.result === 'SUNK')
    .map((s) => s.turn)
    .sort((a, b) => a - b);
  const shotsPerTurn = new Map<number, number>();
  for (const s of obs.shotsAgainstMe) shotsPerTurn.set(s.turn, (shotsPerTurn.get(s.turn) ?? 0) + 1);

  // Their turns are the ones with the opposite parity to ours.
  const myParity = obs.turn % 2;
  let turns = 0;
  let slackTurns = 0;
  for (let t = 1; t < obs.turn; t++) {
    if (t % 2 === myParity) continue;
    turns++;
    const lost = sunkByTurn.filter((st) => st <= t).length;
    const budget = Math.max(AP_FLOOR, Math.min(AP_CAP, FLEET.length - lost));
    const spentOnShells = (shotsPerTurn.get(t) ?? 0) * AP_COST.FIRE;
    if (budget - spentOnShells >= moveCost) slackTurns++;
  }
  return { turns, slackTurns };
}

// Read the opponent off the redacted observation. Nothing here is privileged: every input
// is either public rule arithmetic or a shell we watched land.
export function profileOpponent(obs: Observation, t: Tuning, lockedOut = false): OpponentProfile {
  const flips = obs.config.movement ? countFlips(obs) : 0;
  const wakes = obs.enemyWakes.length;

  const window = Math.min(t.profileWindow, obs.turn);
  const theirTurns = Math.max(1, Math.floor(window / 2));
  const theirBudget = Math.max(AP_FLOOR, Math.min(AP_CAP, obs.enemyShipsRemaining));
  const recentShots = obs.shotsAgainstMe.filter((s) => obs.turn - s.turn <= window).length;
  const shellShare = Math.min(1, (recentShots * AP_COST.FIRE) / Math.max(1, theirTurns * theirBudget));

  const wounded = obs.myShips.some((s) => s.sunk || s.hits.some(Boolean));
  const hunting = shellShare >= t.hunterShellShare && wounded;

  // STATIC must be proven: enough turns watched, no unexplained move-worth of AP, and no
  // movement fingerprint in our records.
  const { turns, slackTurns } = obs.config.movement
    ? apForensics(obs, AP_COST.MOVE)
    : { turns: 0, slackTurns: 0 };
  const provenStill =
    turns >= t.staticMinTurns && slackTurns === 0 && flips === 0 && wakes === 0;
  const dodging = obs.config.movement && (lockedOut || !provenStill);

  return {
    flips,
    wakes,
    shellShare,
    dodging,
    hunting,
    read: dodging ? 'DODGER' : 'STATIC',
  };
}

// LIEUTENANT — the scout-sniper: profiles the opponent (STATIC: misses final; DODGER: intel
// expires, wakes chased; HUNTER: buys decoys and sidesteps) and won't fire into a flat
// belief, buying sonar until the best shot clears the sniper gate.
export function makeLieutenant(
  samples = LIEUTENANT_TUNING.samples,
  tuning: Tuning = LIEUTENANT_TUNING,
): Bot {
  return (obs, legal, rng) => {
    const legalSet = new Set(legal);
    if (legalSet.size <= 1) return { type: 'PASS' };

    let profile = profileOpponent(obs, tuning);

    // A static fleet's aged intel is still exactly true: no decay.
    const beliefFor = (p: OpponentProfile) =>
      targetBelief(obs, samples, p.dodging ? tuning.dodgerMissDecayTurns : null, tuning.missFloor, rng);
    let belief = beliefFor(profile);

    if (obs.ap >= AP_COST.FIRE) {
      const finishing = pickFinishingShot(obs, belief, legalSet, tuning, rng);
      if (finishing) return finishing;
    }

    const windows = (p: OpponentProfile) =>
      p.dodging
        ? { shotRepeatWindow: tuning.dodgerShotRepeatWindow, reshootHitAfter: tuning.dodgerReshootHitAfter }
        : { shotRepeatWindow: tuning.staticShotRepeatWindow, reshootHitAfter: tuning.staticReshootHitAfter };

    let exclude = buildShotExclusions(obs, windows(profile));
    let target = hottestCell(belief.heat, exclude, rng);

    // Lockout proves movement: a STATIC read with no target left was wrong. Re-read as a
    // DODGER and rebuild.
    if (target === null && !profile.dodging && obs.config.movement) {
      profile = profileOpponent(obs, tuning, true);
      belief = beliefFor(profile);
      exclude = buildShotExclusions(obs, windows(profile));
      target = hottestCell(belief.heat, exclude, rng);
    }

    const triage = obs.enemyShipsRemaining <= tuning.triageAtEnemyShips;

    // HUNTER read: buy the bait and the sidestep (the only time this bot spends on
    // defence).
    if (profile.hunting && !triage) {
      const decoy = pickDecoy(obs, legalSet, tuning, rng);
      if (decoy) return decoy;
      if (obs.shotsAgainstMe.length > 0 && anyMoveLegal(legalSet)) {
        const evade = pickEvasiveMove(obs, threatBelief(obs, tuning.threatSamples, rng), legalSet, tuning, rng);
        if (evade) return evade.action;
      }
    }

    // The sniper gate: a shell fired into a flat belief is a wasted shell.
    const h0 = bestHeat(belief.heat, exclude);
    const meanHeat = meanPositiveHeat(belief.heat);
    const worthAShell = h0 >= tuning.sniperMinHeat && h0 >= tuning.sniperStrongRatio * meanHeat;
    const pingsThisTurn = obs.myPings.filter((p) => p.turn === obs.turn).length;
    if (!triage && !worthAShell && pingsThisTurn < tuning.gatePingsPerTurn) {
      const scout = sonarSpend(obs, belief, legalSet, tuning, rng, profile.dodging, () =>
        pickEntropyPing(obs, belief, legalSet, tuning, rng));
      if (scout) return scout;
    }

    // Odd leftover AP can't buy a shell; spend it on sonar rather than forfeit.
    if (obs.ap % 2 === 1) {
      const spare = sonarSpend(obs, belief, legalSet, tuning, rng, profile.dodging, () =>
        pickEntropyPing(obs, belief, legalSet, tuning, rng));
      if (spare) return spare;
    }

    if (obs.ap >= AP_COST.FIRE && target !== null) {
      const action: Action = { type: 'FIRE', cell: target };
      if (legalSet.has(encodeAction(action))) return action;
    }

    // Everything resolved and still no kill: probe the stale misses, where a hull must
    // hide.
    if (obs.ap >= AP_COST.FIRE) {
      const misses = gatherIntel(obs).misses;
      if (misses.length > 0) {
        const cell = misses[rngInt(rng, misses.length)]!.cell;
        if (legalSet.has(encodeAction({ type: 'FIRE', cell }))) return { type: 'FIRE', cell };
      }
    }
    return fireAnywhere(obs, belief, legalSet, rng) ?? { type: 'PASS' };
  };
}
