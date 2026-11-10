import {
  AP_COST,
  EXT_BASE,
  EXT_STRIDE,
  MOVE_BASE,
  PASS_ID,
  FORK_BASE,
  SCAN_BASE,
  SCAN_SIZE,
  ECHO_BASE,
  ECHO_SIZE,
  SPRAY_BASE,
  FIRE_BASE,
  TOOL_BASE,
  TOOL_PLANE,
  blockCells,
  blockFits,
  sprayCells,
  sprayFits,
  shipCells,
  pingCells,
  toolCost,
  FLEET,
  intelAlive,
  baseActionId,
  encodeAction,
  type Action,
  type Observation,
  type PlayerId,
  type RNG,
  type ShotRecord,
  type TargetIntel,
  type ToolId,
  decodeAction,
} from '../engine';
import { PING_CONTACT_TRUST, buildBelief } from './montecarlo';
// Imported leaf-first rather than through ./index, which re-exports this module.
import { ADMIRAL_TUNING } from './admiral';
import { makeBot } from './ranks';
import type { Bot, BotName } from './types';

// MELEE adapter: the unmodified two-player ranks play three-handed by projection —
// pick a target (each rank has one target rule, in chooseTarget), show the rank a duel,
// then re-address its action.

// Total hull cells in a fleet — the yardstick for "how close is this one to dead".
const FLEET_HULL = FLEET.reduce((sum, ship) => sum + ship.length, 0);

// Turn numbers on the alternating two-player clock the ranks expect (exact, since each seat
// acts once per round). Rounds count from `first`, my own first turn: my actions land on
// odd virtual turns, anything rivals did between two of my turns on the even turn just
// before the later one.
function vSelf(turn: number, n: number, first: number): number {
  return 2 * Math.floor((turn - first) / n) + 1;
}

function vOther(turn: number, n: number, first: number): number {
  // max(0, …) folds the -0 that pre-first-turn records would otherwise produce.
  return Math.max(0, 2 * Math.ceil((turn - first) / n));
}

const reclock = <T extends { turn: number }>(records: T[], n: number, first: number, mine: boolean): T[] =>
  records.map((r) => ({ ...r, turn: mine ? vSelf(r.turn, n, first) : vOther(r.turn, n, first) }));

// Distinct cells on `target`'s board known to hold ship — the public damage record. Decoy
// fake-hits inflate this; everyone is fooled equally, so the comparison stays fair.
function hullStruck(intel: TargetIntel): number {
  const struck = new Set<number>();
  for (const s of intel.shots) if (s.result !== 'MISS') struck.add(s.cell);
  return struck.size;
}

// Cells hit on a ship that has NOT yet sunk (a wounded hull is pinned, so it's cheap to
// finish).
function openWounds(intel: TargetIntel): number {
  const sunkCells = new Set<number>();
  const hits = new Set<number>();
  for (const s of intel.shots) {
    if (s.result === 'SUNK') sunkCells.add(s.cell);
    else if (s.result === 'HIT') hits.add(s.cell);
  }
  // A SUNK record closes out its ship, but only names the sinking cell; treat any hit
  // within one step of a sunk cell as accounted for.
  const steps = (a: number, b: number) =>
    Math.abs((a % 10) - (b % 10)) + Math.abs(Math.floor(a / 10) - Math.floor(b / 10));
  let open = 0;
  for (const c of hits) {
    if (![...sunkCells].some((s) => steps(s, c) <= 1)) open++;
  }
  return open;
}

// Project the melee view onto one enemy, in the shape a two-player rank expects.
export function projectObservation(obs: Observation, target: PlayerId): Observation {
  const n = obs.playerCount;
  // Bots only decide on their own turn, and seats keep a fixed slot, so this is my first.
  const first = ((obs.turn - 1) % n) + 1;
  const intel = obs.intel[target]!;
  // Every seat's fire at this board (damage is public), clocked per record: my shells on MY
  // virtual turn, others' on the turn before, or my own intel ages a turn too fast.
  const shots: ShotRecord[] = intel.shots.map((s) => ({
    ...s,
    turn: s.by === obs.me ? vSelf(s.turn, n, first) : vOther(s.turn, n, first),
  }));
  return {
    config: obs.config,
    me: 0,
    playerCount: 2,
    turn: vSelf(obs.turn, n, first),
    ap: obs.ap,
    budget: obs.budget,
    // The melee sonar price, unchanged, or the rank buys sweeps it cannot afford.
    pingCost: obs.pingCost,
    movedShips: obs.movedShips,
    myShips: obs.myShips,
    myDecoys: obs.myDecoys,
    myDecoysLeft: obs.myDecoysLeft,
    myToolCooldowns: obs.myToolCooldowns,
    myHullDown: obs.myHullDown,
    // Incoming fire pooled across attackers: a cell either one has found is a cell I'm
    // exposed on.
    shotsAgainstMe: reclock(obs.shotsAgainstMe, n, first, false),
    myShots: shots,
    myPings: reclock(intel.pings, n, first, true),
    enemyWakes: reclock(intel.wakes, n, first, false),
    enemySunk: intel.sunk,
    enemyShipsRemaining: intel.shipsRemaining,
    intel: [null, { ...intel, shots, pings: reclock(intel.pings, n, first, true) }],
  };
}

// Fold the legal set down to the canonical 0–324 space for one target. Ranks must never see
// a rebased id: they read legality off canonical FIRE/PING ids.
function projectLegal(legal: number[], at: number): number[] {
  const out: number[] = [];
  for (const id of legal) {
    if (id < MOVE_BASE) {
      // The canonical FIRE/PING planes address the next seat.
      if (at === 1) out.push(id);
    } else if (id <= PASS_ID) {
      out.push(id);
    } else if (Math.floor((id - EXT_BASE) / EXT_STRIDE) + 2 === at) {
      out.push(baseActionId(id));
    }
  }
  return out;
}

// Re-address a decision made against the projection. MOVE, DECOY and PASS are entirely
// self-directed and pass through untouched.
function restamp(action: Action, at: number): Action {
  if (at === 1) return action;
  if (action.type === 'FIRE') return { ...action, at };
  if (action.type === 'PING') return { ...action, at };
  return action;
}

// Rivals still in the fight. A destroyed fleet keeps its seat (offsets never renumber), so
// every target rule and tool choice funnels through here.
const opponentsOf = (obs: Observation): PlayerId[] =>
  obs.intel.map((_, seat) => seat).filter((seat) => seat !== obs.me && intelAlive(obs.intel[seat]!));

// Estimated hull still floating on a board. Public information.
const hullLeft = (intel: TargetIntel) => FLEET_HULL - hullStruck(intel);

// ───────── finishing ─────────
//
// Survivors play on after a kill, so finishing a cripple takes a gun off the table. Reads
// the PUBLIC hull estimate, so a decoy-inflated fleet can goad a bot into a hopeless
// finish.

// Estimated hull within which a fleet's last ship could go down to this turn's fire.
const KILL_RANGE_HULL = 3;

// Both halves matter: one untouched carrier left is one ship but five squares.
const finishable = (intel: TargetIntel) =>
  intel.shipsRemaining <= 1 && hullLeft(intel) <= KILL_RANGE_HULL;

// Override the rank's pick unconditionally when a rival is within reach of dead.
function finishingTarget(obs: Observation, pick: PlayerId): PlayerId {
  return opponentsOf(obs).find((seat) => finishable(obs.intel[seat]!)) ?? pick;
}

// `temp` > 0 turns the argmax into a softmax draw over the same scores (useful range
// 0.05..0.2). Both paths draw rng() exactly once, so the knob changes only the seat picked.
function pickByScore(
  obs: Observation,
  rng: RNG,
  score: (intel: TargetIntel, seat: PlayerId) => number,
  temp = 0,
): PlayerId {
  if (temp > 0) return softmaxPick(obs, rng, score, temp);
  let best = -Infinity;
  let ties: PlayerId[] = [];
  for (const seat of opponentsOf(obs)) {
    const s = score(obs.intel[seat]!, seat);
    if (s > best + 1e-9) {
      best = s;
      ties = [seat];
    } else if (Math.abs(s - best) <= 1e-9) {
      ties.push(seat);
    }
  }
  return ties[Math.floor(rng() * ties.length)] ?? opponentsOf(obs)[0]!;
}

function softmaxPick(
  obs: Observation,
  rng: RNG,
  score: (intel: TargetIntel, seat: PlayerId) => number,
  temp: number,
): PlayerId {
  const seats = opponentsOf(obs);
  const scores = seats.map((seat) => score(obs.intel[seat]!, seat));
  // Shift by the max before exponentiating, so very negative scores can't underflow to
  // zero.
  const top = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - top) / temp));
  const total = weights.reduce((a, b) => a + b, 0);
  let draw = rng() * total;
  for (let i = 0; i < seats.length; i++) {
    draw -= weights[i]!;
    if (draw <= 0) return seats[i]!;
  }
  return seats[seats.length - 1] ?? 0;
}

// Samples for the adapter's own side pictures (target choice, tool pricing): these rank
// boards and price footprints, they don't aim the shell. Capped by the rank's own sample
// count, so a cheap sim run is cheap throughout; at 200 or more it is exactly 200.
const AUX_SAMPLES = 200;

// How sharply my own recon localizes this fleet: the peak of a belief built from what I
// know about it.
function auxBelief(obs: Observation, seat: PlayerId, rng: RNG, samples: number) {
  return buildBelief(projectObservation(obs, seat), {
    samples,
    missDecayTurns: 12,
    usePings: true,
    maxAttempts: 8,
  }, rng);
}

function localisation(obs: Observation, seat: PlayerId, rng: RNG, samples: number): number {
  const belief = auxBelief(obs, seat, rng, samples);
  let peak = 0;
  for (let c = 0; c < 100; c++) peak = Math.max(peak, belief.heat[c] ?? 0);
  return peak;
}

// How dead a board is, 0..1.
const weakness = (intel: TargetIntel) => hullStruck(intel) / FLEET_HULL;

// How dangerous a board still is, 0..1. An untouched fleet is the biggest long-run threat
// even though it is the hardest kill.
const threat = (intel: TargetIntel) => intel.shipsRemaining / FLEET.length;

// How far a fleet is AHEAD on hull left versus the rest of the live table, 0..1 (0 when
// it is not ahead). The fleet that waited while the others traded blows sits on the lead;
// a hunter that never weighs it hands that fleet the game. Public hull for rivals, my own
// board's truth for me.
const LEAD_WEIGHT = 8;

// Share of a fleet's hull still afloat, 0..1: public estimate for rivals, truth for me.
const hullShare = (obs: Observation, s: PlayerId) =>
  (s === obs.me ? FLEET_HULL - obs.myHullDown : hullLeft(obs.intel[s]!)) / FLEET_HULL;

function lead(obs: Observation, seat: PlayerId): number {
  const left = (s: PlayerId) => hullShare(obs, s);
  const others = [obs.me, ...opponentsOf(obs)].filter((s) => s !== seat);
  const mean = others.reduce((sum, s) => sum + left(s), 0) / others.length;
  return Math.max(0, left(seat) - mean);
}

// How much I want the OTHER guns on this board, -1..1: the leader yes, a fleet whose death
// would leave me alone with the leader no. 0 in the duel phase, with nobody left to steer.
const STEER_SCALE = 4;

function steer(obs: Observation, seat: PlayerId): number {
  const rest = opponentsOf(obs).filter((s) => s !== seat);
  if (rest.length === 0) return 0;
  const left = (s: PlayerId) => hullShare(obs, s);
  const mean = [obs.me, ...rest].reduce((sum, s) => sum + left(s), 0) / (rest.length + 1);
  return Math.max(-1, Math.min(1, STEER_SCALE * (left(seat) - mean)));
}

// A board somebody ECHOed within the last round, scaled by how much answered, 0..1. That
// chart is public, so it is the cheapest board at the table to hit: guns pile on.
const LIT_WEIGHT = 1;

function lit(obs: Observation, seat: PlayerId): number {
  const since = obs.turn - obs.playerCount;
  let glow = 0;
  for (const p of obs.intel[seat]!.pings) {
    if (p.occupancy !== undefined && p.turn > since) glow = Math.max(glow, Math.min(1, p.occupancy / 4));
  }
  return glow;
}

// Neglect bonus: how far my share of shells at this board falls below the floor (0 above
// it). Stops two bots locking onto each other while a quiet third fleet goes untouched; a
// floor, not a constant pull, so focus fire on a wounded hull is left alone.
const NEGLECT_FLOOR = 0.35;

function neglect(obs: Observation, seat: PlayerId): number {
  let mine = 0;
  let total = 0;
  obs.intel.forEach((board, i) => {
    if (!board) return;
    for (const r of board.shots) {
      if (r.by !== obs.me) continue;
      total++;
      if (i === seat) mine++;
    }
  });
  if (total === 0) return 0;
  return Math.max(0, NEGLECT_FLOOR - mine / total);
}

// Records from before this turn opened — what a target rule reads when it should commit to
// one plan for every shell of a 5-AP turn, without any stored state.
function beforeThisTurn<T extends { turn: number }>(records: T[], turn: number): T[] {
  return records.filter((r) => r.turn < turn);
}

// Hull each rival has really taken off MY fleet: the first shell on each of my damaged
// segments. Misses and decoy-absorbed shells cost me nothing, so they count for nothing —
// a four-shell SPRAY that whiffs is not a threat. My own board is the one I see truly.
function hullTakenFromMe(obs: Observation): Map<PlayerId, number> {
  const damaged = new Set<number>();
  for (const ship of obs.myShips) shipCells(ship).forEach((c, seg) => ship.hits[seg] && damaged.add(c));
  const out = new Map<PlayerId, number>();
  const counted = new Set<number>();
  for (const s of beforeThisTurn(obs.shotsAgainstMe, obs.turn)) {
    if (s.by === undefined || !damaged.has(s.cell) || counted.has(s.cell)) continue;
    counted.add(s.cell);
    out.set(s.by, (out.get(s.by) ?? 0) + 1);
  }
  return out;
}

// Real hits each seat has landed anywhere, read off the attributed public log.
function damageDealt(obs: Observation): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  const bump = (by: PlayerId | undefined, n = 1) => {
    if (by === undefined) return;
    out.set(by, (out.get(by) ?? 0) + n);
  };
  for (const seat of opponentsOf(obs)) {
    for (const s of beforeThisTurn(obs.intel[seat]!.shots, obs.turn)) {
      if (s.result !== 'MISS') bump(s.by);
    }
  }
  // Fire at my own board is recorded separately, and its results are mine to see.
  for (const [by, n] of hullTakenFromMe(obs)) bump(by, n);
  return out;
}

// Roll every log back to where it stood when the turn opened, so target scoring can't shift
// between the AP spends of one turn (commitTurn; off by default).
function freezeIntel(obs: Observation): Observation {
  return {
    ...obs,
    shotsAgainstMe: beforeThisTurn(obs.shotsAgainstMe, obs.turn),
    intel: obs.intel.map((board) =>
      board === null ? null : { ...board, shots: beforeThisTurn(board.shots, obs.turn) },
    ),
  };
}

function chooseTarget(
  rank: BotName,
  live: Observation,
  rng: RNG,
  temp: number,
  commit: boolean,
  samples: number,
  litPull: boolean,
): PlayerId {
  const obs = commit ? freezeIntel(live) : live;
  // Every rank but the naive floor is drawn to a freshly lit board.
  const glow = (seat: PlayerId) => (litPull && rank !== 'ensign' ? lit(obs, seat) * LIT_WEIGHT : 0);
  const pick = (score: (intel: TargetIntel, seat: PlayerId) => number) =>
    pickByScore(obs, rng, (intel, seat) => score(intel, seat) + glow(seat), temp);
  switch (rank) {
    // CAPTAIN — shoot whoever my own sonar has pinned down best, a wounded hull breaking
    // ties.
    case 'captain':
      return pick((intel, seat) =>
        localisation(obs, seat, rng, samples) + openWounds(intel) * 0.01 +
        weakness(intel) * 0.5 + threat(intel) * 0.3 + neglect(obs, seat) * 4,
      );
    // COMMANDER — shoot whoever is closest to dying, read off the public damage log.
    case 'commander':
      return pick((intel, seat) =>
        weakness(intel) * 1.5 + threat(intel) * 0.3 + neglect(obs, seat) * 4,
      );
    // ENSIGN — spread my fire evenly, counting only my own shells. Deliberately naive: the
    // random floor should not pick targets well.
    case 'ensign':
      return pick((intel) => -intel.shots.filter((s) => s.by === obs.me).length);
    // COMMODORE — bash whoever is winning: the most damage dealt, or the biggest hull lead.
    case 'commodore': {
      const dealt = damageDealt(obs);
      const top = Math.max(1, ...dealt.values());
      return pick((intel, seat) =>
        (dealt.get(seat) ?? 0) / top + weakness(intel) * 0.5 + threat(intel) * 0.3 +
        lead(obs, seat) * LEAD_WEIGHT + neglect(obs, seat) * 4,
      );
    }
    // LIEUTENANT and ADMIRAL — retaliate against whoever has done my fleet the most real
    // damage: both play the OPPONENT rather than the board. ADMIRAL also weighs the lead, so
    // a fleet sitting out the fight does not ride it to the win.
    case 'lieutenant':
    case 'admiral': {
      const atMe = hullTakenFromMe(obs);
      const worst = Math.max(1, ...atMe.values());
      return pick((intel, seat) =>
        (atMe.get(seat) ?? 0) / worst + weakness(intel) * 0.5 + threat(intel) * 0.3 +
        (rank === 'admiral' ? lead(obs, seat) * LEAD_WEIGHT : 0) + neglect(obs, seat) * 4,
      );
    }
  }
}

const TOOL_MIN_BRANCH = 25;

// Per-cell ship counts summed over a set of sampled fleets.
function cellCounts(list: Uint8Array[]): Float64Array {
  const counts = new Float64Array(100);
  for (const occ of list) for (let c = 0; c < 100; c++) counts[c]! += occ[c]!;
  return counts;
}

// One enemy board's belief for tool pricing. `heat` zeroes cells anyone has already fired
// at: a spent cell can never pay out again, so it must not flatter a footprint.
function boardBelief(obs: Observation, seat: PlayerId, rng: RNG, samples: number) {
  const belief = auxBelief(obs, seat, rng, samples);
  const shots = obs.intel[seat]!.shots;
  const spent = new Set(shots.map((x) => x.cell));
  const hits = new Set(shots.filter((x) => x.result !== 'MISS').map((x) => x.cell));
  const heat = (cell: number) => (spent.has(cell) ? 0 : belief.heat[cell] ?? 0);
  let best = 0;
  for (let c = 0; c < 100; c++) best = Math.max(best, heat(c));
  // What a sweep of `cells` is worth: the expected rise in the best next shot once its
  // answer is read — yes/no (PING), exactly which cells (SCAN) or how many (ECHO). Branches
  // thin in samples shrink toward the prior; an answer that names a ship is trusted only
  // PING_CONTACT_TRUST of the time, as buildBelief discounts it.
  type Read = 'yesno' | 'exact' | 'occupancy';
  // Samples grouped by the answer a sweep of `cells` would give; null if it can't tell
  // anything apart.
  const branchesOf = (cells: number[], read: Read) => {
    const region = cells.filter((c) => !hits.has(c));
    if (region.length === 0 || belief.samples.length === 0) return null;
    const branches = new Map<string, Uint8Array[]>();
    for (const { occupancy: occ } of belief.samples) {
      const live = region.filter((c) => occ[c] === 1);
      const key = read === 'yesno' ? String(live.length > 0)
        : read === 'occupancy' ? String(live.length) : live.join(',');
      const list = branches.get(key);
      if (list) list.push(occ);
      else branches.set(key, [occ]);
    }
    return branches;
  };
  const contact = (key: string) => key !== 'false' && key !== '0' && key !== '';
  const sweepGain = (cells: number[], read: Read) => {
    const branches = branchesOf(cells, read);
    const n = belief.samples.length;
    if (!branches) return 0;
    let value = 0;
    for (const [key, list] of branches) {
      const counts = cellCounts(list);
      let top = 0;
      for (let c = 0; c < 100; c++) if (!spent.has(c)) top = Math.max(top, counts[c]! / list.length);
      const w = Math.min(1, list.length / TOOL_MIN_BRANCH);
      let branchBest = w * top + (1 - w) * best;
      if (contact(key)) {
        branchBest = PING_CONTACT_TRUST * branchBest + (1 - PING_CONTACT_TRUST) * best;
      }
      value += (list.length / n) * branchBest;
    }
    return value - best;
  };
  // Expected hits from `k` aimed shells within `list`, re-aiming on each one's answer (5 AP
  // buys at most two). Thin branches shrink toward the prior, as in sweepGain.
  const volley = (list: Uint8Array[], k: number, used: number[] = []): number => {
    if (k <= 0 || list.length === 0) return 0;
    const counts = cellCounts(list);
    let cell = -1;
    for (let c = 0; c < 100; c++) {
      if (spent.has(c) || used.includes(c)) continue;
      if (cell < 0 || counts[c]! > counts[cell]!) cell = c;
    }
    if (cell < 0) return 0;
    const w = Math.min(1, list.length / TOOL_MIN_BRANCH);
    const value = w * (counts[cell]! / list.length) + (1 - w) * best;
    if (k === 1) return value;
    const hit = list.filter((occ) => occ[cell] === 1);
    const miss = list.filter((occ) => occ[cell] === 0);
    const next = [...used, cell];
    return value + (hit.length * volley(hit, k - 1, next) + miss.length * volley(miss, k - 1, next)) / list.length;
  };
  const everything = belief.samples.map((s) => s.occupancy);
  const blindMemo = new Map<number, number>();
  // `k` shells on what is already known.
  const shells = (k: number) => {
    if (!blindMemo.has(k)) blindMemo.set(k, volley(everything, k));
    return blindMemo.get(k)!;
  };
  // Expected hits from a sweep of `cells`, then `k` shells aimed on its answer. A contact
  // branch is trusted PING_CONTACT_TRUST, the rest falls back to shooting blind.
  const sweepThenShells = (cells: number[], read: Read, k: number) => {
    const branches = branchesOf(cells, read);
    if (!branches || k <= 0) return shells(k);
    let value = 0;
    for (const [key, list] of branches) {
      const v = volley(list, k);
      value += (list.length / everything.length) *
        (contact(key) ? PING_CONTACT_TRUST * v + (1 - PING_CONTACT_TRUST) * shells(k) : v);
    }
    return value;
  };
  // Expected hits from two aimed shells fired the way a rank fires them: the best cell,
  // then the best cell given what the first one reported. SPRAY's four shells land blind.
  const aimedPair = () => {
    let first = -1;
    for (let c = 0; c < 100; c++) if (first < 0 || heat(c) > heat(first)) first = c;
    const n = belief.samples.length;
    if (first < 0 || n === 0) return 2 * best;
    let value = heat(first);
    for (const hit of [1, 0]) {
      const list = belief.samples.filter((x) => x.occupancy[first] === hit);
      if (list.length === 0) continue;
      const counts = cellCounts(list.map((x) => x.occupancy));
      let top = 0;
      for (let c = 0; c < 100; c++) if (c !== first && !spent.has(c)) top = Math.max(top, counts[c]! / list.length);
      const w = Math.min(1, list.length / TOOL_MIN_BRANCH);
      value += (list.length / n) * (w * top + (1 - w) * best);
    }
    return value;
  };
  return { heat, sweepGain, aimedPair, shells, sweepThenShells };
}

const massOf = (cells: number[], heat: (c: number) => number) =>
  cells.reduce((sum, c) => sum + heat(c), 0);

// Best anchor for a footprint, by any score.
function bestAnchor(fits: (cell: number) => boolean, score: (cell: number) => number) {
  let best = { cell: -1, value: 0 };
  for (let cell = 0; cell < 100; cell++) {
    if (!fits(cell)) continue;
    const value = score(cell);
    if (value > best.value) best = { cell, value };
  }
  return best;
}

// Tool policy: a tool only upgrades an attacking action the rank already chose, so it never
// pre-empts its dodging or decoys. A gun (SPRAY, FORK) replaces a FIRE; a sonar (SCAN,
// ECHO) a FIRE or a PING, since the ranks rarely ping once the locker is open. Guns are
// priced against aimed shells, sonars against the best PING; the best ratio above 1 wins.
function toolChoice(
  obs: Observation,
  toolIds: number[],
  target: PlayerId,
  at: number,
  rng: RNG,
  samples: number,
  planned: 'FIRE' | 'PING',
): Action | null {
  const has = (base: number, span: number) => toolIds.some((id) => id >= base && id < base + span);
  const aimed = (a: Action): Action => (at === 1 ? a : ({ ...a, at } as Action));
  const board = boardBelief(obs, target, rng, samples);
  // Expected hits from `ap` worth of aimed shells on one board, fractional shells pro rata.
  const shellsOn = (heat: (c: number) => number) => {
    const singles: number[] = [];
    for (let c = 0; c < 100; c++) singles.push(heat(c));
    singles.sort((a, b) => b - a);
    return (ap: number) => {
      const k = ap / AP_COST.FIRE;
      let sum = 0;
      for (let i = 0; i < Math.ceil(k); i++) sum += singles[i]! * Math.min(1, k - i);
      return sum;
    };
  };
  const pingGain = bestAnchor(() => true, (c) => board.sweepGain(pingCells(c), 'yesno')).value;
  const perPing = pingGain / AP_COST.PING;

  const offers: { action: Action; ratio: number }[] = [];
  const offer = (action: Action, value: number, plain: number) => {
    if (value > 0) offers.push({ action, ratio: plain > 0 ? value / plain : Infinity });
  };
  const span = TOOL_PLANE * (obs.playerCount - 1);

  if (has(SCAN_BASE, span)) {
    const scan = bestAnchor((c) => blockFits(c, SCAN_SIZE),
      (c) => board.sweepGain(blockCells(c, SCAN_SIZE), 'exact'));
    if (scan.cell >= 0) offer(aimed({ type: 'SCAN', cell: scan.cell }), scan.value, perPing * toolCost('SCAN'));
  }
  if (has(ECHO_BASE, span)) {
    const echo = bestAnchor((c) => blockFits(c, ECHO_SIZE),
      (c) => board.sweepGain(blockCells(c, ECHO_SIZE), 'occupancy'));
    if (echo.cell >= 0) offer(aimed({ type: 'ECHO', cell: echo.cell }), echo.value, perPing * toolCost('ECHO'));
  }
  if (planned === 'FIRE' && has(SPRAY_BASE, span)) {
    const spray = bestAnchor(sprayFits, (c) => massOf(sprayCells(c), board.heat));
    if (spray.cell >= 0) offer(aimed({ type: 'SPRAY', cell: spray.cell }), spray.value, board.aimedPair());
  }
  if (planned === 'FIRE' && has(FORK_BASE, TOOL_PLANE)) {
    // FORK lands on every board, so its yardstick is aimed shells at the best of them.
    const heats = opponentsOf(obs).map((seat) => (seat === target ? board.heat : boardBelief(obs, seat, rng, samples).heat));
    const fork = bestAnchor(() => true, (c) => heats.reduce((sum, h) => sum + h(c), 0));
    const plain = Math.max(...heats.map((h) => shellsOn(h)(toolCost('FORK'))));
    if (fork.cell >= 0) offer({ type: 'FORK', cell: fork.cell }, fork.value, plain);
  }

  const best = offers.reduce<{ action: Action; ratio: number } | null>(
    (a, b) => (a && a.ratio >= b.ratio ? a : b), null);
  return best && best.ratio > 1 ? best.action : null;
}

// ───────── turn plans (ADMIRAL) ─────────
//
// toolChoice prices one action against the next shell. A turn plan prices the whole turn:
// SCAN is worth the shells it aims, not just the next one. Scored in expected hits this turn
// plus what a sweep still teaches after it, priced as ADMIRAL prices any sweep (voiHorizon ×
// the rise in the best next shell). AP left idle counts for nothing (it never carries over).
// Stateless: re-planned every spend, with what the turn has already turned up read straight
// off the observation.

// My sweeps this turn, and the board they were pointed at — a plan in progress.
function sweptThisTurn(obs: Observation): PlayerId | null {
  for (const seat of opponentsOf(obs)) {
    if (obs.intel[seat]!.pings.some((p) => p.turn === obs.turn)) return seat;
  }
  return null;
}

// Cells my SCAN marked live this turn that no shell has touched yet. SCAN files one
// single-cell record per cell it looked at (see step.ts), so that is how one reads.
function scanLeads(obs: Observation, seat: PlayerId): number[] {
  const intel = obs.intel[seat]!;
  const spent = new Set(intel.shots.map((s) => s.cell));
  return intel.pings
    .filter((p) => p.turn === obs.turn && p.cells.length === 1 && p.contact && !spent.has(p.center))
    .map((p) => p.center);
}

function turnPlan(
  obs: Observation,
  toolIds: number[],
  target: PlayerId,
  at: number,
  rng: RNG,
  samples: number,
  planned: Action,
): Action | null {
  const legal = new Set(toolIds);
  const aimed = (a: Action): Action => (at === 1 ? a : ({ ...a, at } as Action));
  const board = boardBelief(obs, target, rng, samples);
  const ap = obs.ap;
  const shellsFor = (left: number) => Math.max(0, Math.floor(left / AP_COST.FIRE));
  // What a sweep's answer is still worth once this turn's shells are spent.
  const carry = (cells: number[], read: 'yesno' | 'exact' | 'occupancy') =>
    ADMIRAL_TUNING.voiHorizon * Math.max(0, board.sweepGain(cells, read));
  // The rank's own plan: its ping then shells, or shells alone.
  const plain = planned.type === 'PING'
    ? board.sweepThenShells(pingCells(planned.center), 'yesno', shellsFor(ap - obs.pingCost)) +
      carry(pingCells(planned.center), 'yesno')
    : board.shells(shellsFor(ap));

  let best: { action: Action | null; value: number } = { action: null, value: plain };
  const consider = (action: Action, value: number) => {
    if (value > best.value + 1e-9 && legal.has(encodeAction(action))) best = { action, value };
  };
  // Every live rival that would also read an ECHO, weighted by whether I want them firing
  // at this board. They shoot it on their own turn, so their lift is a full two-shell one.
  const rivals = opponentsOf(obs).length - 1;
  const pull = steer(obs, target);

  for (let cell = 0; cell < 100; cell++) {
    if (ap >= toolCost('SCAN') && blockFits(cell, SCAN_SIZE)) {
      const cells = blockCells(cell, SCAN_SIZE);
      consider(aimed({ type: 'SCAN', cell }),
        board.sweepThenShells(cells, 'exact', shellsFor(ap - toolCost('SCAN'))) + carry(cells, 'exact'));
    }
    if (ap >= toolCost('ECHO') && blockFits(cell, ECHO_SIZE)) {
      const cells = blockCells(cell, ECHO_SIZE);
      const mine = board.sweepThenShells(cells, 'occupancy', shellsFor(ap - toolCost('ECHO')));
      const lift = rivals > 0 && pull !== 0
        ? board.sweepThenShells(cells, 'occupancy', 2) - board.shells(2) : 0;
      consider(aimed({ type: 'ECHO', cell }), mine + carry(cells, 'occupancy') + rivals * pull * lift);
    }
    if (planned.type === 'FIRE' && ap >= toolCost('SPRAY') && sprayFits(cell)) {
      consider(aimed({ type: 'SPRAY', cell }),
        massOf(sprayCells(cell), board.heat) + board.shells(shellsFor(ap - toolCost('SPRAY'))));
    }
  }
  if (planned.type === 'FIRE' && ap >= toolCost('FORK')) {
    const heats = opponentsOf(obs).map((seat) => (seat === target ? board.heat : boardBelief(obs, seat, rng, samples).heat));
    const fork = bestAnchor(() => true, (c) => heats.reduce((sum, h) => sum + h(c), 0));
    if (fork.cell >= 0) {
      consider({ type: 'FORK', cell: fork.cell }, fork.value + board.shells(shellsFor(ap - toolCost('FORK'))));
    }
  }
  return best.action;
}

export interface MeleeOptions {
  samples?: number;
  // Softmax temperature for target selection; 0 (default) is argmax. See pickByScore.
  targetTemp?: number;
  // Score target choice off the board as it stood when the turn opened. See freezeIntel.
  commitTurn?: boolean;
  // Tools this seat never fires (sim ablation only; the rules still offer them).
  denyTools?: ToolId[];
  // ADMIRAL prices whole turns rather than single actions (see turnPlan). Default on; off
  // is sim ablation only.
  turnPlan?: boolean;
  // Target rules lean toward a freshly ECHOed board (see lit). Default on; off is sim
  // ablation only.
  litPull?: boolean;
}

// Wrap a rank for MELEE: its own target rule picks the board, the rank plays the duel.
// The result is an ordinary Bot.
export function makeMelee(rank: BotName, opts: MeleeOptions = {}): Bot {
  const inner = makeBot(rank, { samples: opts.samples ?? 1000 });
  const aux = Math.min(AUX_SAMPLES, opts.samples ?? 1000);
  const deny = new Set(opts.denyTools ?? []);
  const denied = (id: number) => deny.size > 0 && deny.has((decodeAction(id) as { type: ToolId }).type);
  const plans = rank === 'admiral' && (opts.turnPlan ?? true);
  return (obs, legal, rng) => {
    // Two players: no target to choose, so the rank plays exactly as it always has.
    if (obs.playerCount < 3) return inner(obs, legal, rng);

    // Split tool ids off ONCE, here: extension-plane arithmetic misreads them (a SPRAY id
    // can pass a PING test). Nothing below this line may see one.
    const toolIds = legal.filter((id) => id >= TOOL_BASE && !denied(id));
    const plain = toolIds.length > 0 ? legal.filter((id) => id < TOOL_BASE) : legal;

    // The rank's rule says who it WANTS to shoot; a kill in reach outranks the preference.
    const wanted = chooseTarget(rank, obs, rng, opts.targetTemp ?? 0, opts.commitTurn ?? false, aux,
      opts.litPull ?? true);
    // A planner that swept a board this turn stays on it: the sweep was bought for the
    // shells that follow.
    const target = finishingTarget(obs, (plans ? sweptThisTurn(obs) : null) ?? wanted);
    const at = (target - obs.me + obs.playerCount) % obs.playerCount;
    const projectedLegal = projectLegal(plain, at);
    // A target with nothing affordable against it (no AP for a shell or a sweep) leaves
    // only self-directed moves, which the rank can still use.
    const planned = inner(projectObservation(obs, target), projectedLegal, rng);
    const attacking = planned.type === 'FIRE' || planned.type === 'PING';
    if (plans && attacking) {
      // Finish the plan first: shoot what this turn's SCAN marked live.
      const lead = scanLeads(obs, target).find((c) => projectedLegal.includes(FIRE_BASE + c));
      if (lead !== undefined) return restamp({ type: 'FIRE', cell: lead }, at);
      if (toolIds.length > 0) {
        const tool = turnPlan(obs, toolIds, target, at, rng, aux, planned);
        if (tool) return tool;
      }
      return restamp(planned, at);
    }
    if (toolIds.length > 0 && attacking) {
      const tool = toolChoice(obs, toolIds, target, at, rng, aux, planned.type);
      if (tool) return tool;
    }
    return restamp(planned, at);
  };
}

