import {
  AP_COST,
  FLEET,
  toolCost,
  createGame,
  legalActionIds,
  mulberry32,
  observe,
  pingCostFor,
  randomFleet,
  step,
  type AtLeastTwo,
  type GameConfig,
  type PlayerId,
  type ShipPlacement,
} from '../engine';
import type { Bot } from '../ai/types';
import { emptySide, type SideStats } from './run';

// Three-handed harness, kept apart from run.ts so the two-player benchmarks stay untouched.

export interface MeleeRecord {
  seed: number;
  // Bot index occupying each seat: seatOf[seat] indexes the bots array.
  seatOf: number[];
  // Seat that won, or null for a draw.
  winnerSeat: PlayerId | null;
  // FIRST fleet to be wiped out, or null if nobody died.
  victimSeat: PlayerId | null;
  // Seat that fired that first killing shell. Optional: older records lack it.
  eliminatorSeat?: PlayerId | null;
  // Seat that took the game's first real hit — the snowball probe.
  firstBloodVictim: PlayerId | null;
  turns: number;
  // Real ship-segment hits: damage[by][target].
  damage: number[][];
  // Shells FIRED: shotsAt[by][target], misses and decoy fakes included.
  shotsAt: number[][];
  // Per shooter: shells at the strictly most-damaged seat, over shells fired while one
  // existed (the weakest seat's own fire excluded). Damage-blind aim scores 1/(n-1).
  shotsAtWeakest: number[];
  shotsWithStrictWeakest: number[];
  // Fewest unsunk ships each seat was ever reduced to (the comeback probe).
  lowWater: number[];
  bySeat: SideStats[];
  // Tools fired per seat, by kind. Optional: older records lack it.
  toolsByKind?: Record<string, number>[];
}

// One full headless three-way game. Deterministic for a given (bots, config, seed, seatOf).
export function runMeleeGame(
  bots: Bot[],
  config: GameConfig,
  seed: number,
  seatOf: number[],
): MeleeRecord {
  const n = bots.length;
  const rng = mulberry32(seed);
  const fleets = Array.from({ length: n }, () => randomFleet(rng)) as AtLeastTwo<ShipPlacement[]>;
  let state = createGame(config, fleets, seed);

  const bySeat = Array.from({ length: n }, emptySide);
  const cellsShot = Array.from({ length: n }, () => new Set<number>());
  const damage = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const shotsAt = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const shotsAtWeakest = new Array<number>(n).fill(0);
  const shotsWithStrictWeakest = new Array<number>(n).fill(0);
  const unsunkOf = (s: typeof state) => s.players.map((p) => p.ships.filter((sh) => !sh.sunk).length);
  const lowWater = unsunkOf(state);
  // Hull segments destroyed, per seat — what the target rules score on, finer than ships.
  const hullDownOf = (s: typeof state) =>
    s.players.map((p) => p.ships.reduce((n, sh) => n + sh.hits.filter(Boolean).length, 0));
  // The single most-damaged seat, or null when the lead is shared.
  const weakestSeat = (hullDown: number[]): PlayerId | null => {
    const worst = Math.max(...hullDown);
    if (worst === 0) return null;
    return hullDown.filter((h) => h === worst).length === 1
      ? (hullDown.indexOf(worst) as PlayerId)
      : null;
  };
  let firstBloodVictim: PlayerId | null = null;
  const toolsByKind = Array.from({ length: n }, () => ({ SCAN: 0, ECHO: 0, FORK: 0, SPRAY: 0 }));

  bySeat[state.activePlayer]!.apGranted += state.budget;
  bySeat[state.activePlayer]!.budgetByRound.push(state.budget);
  if (state.budget < AP_COST.FIRE) bySeat[state.activePlayer]!.disarmedTurns++;

  let guard = 0;
  while (state.phase.kind === 'playing' && guard++ < 40000) {
    const seat = state.activePlayer;
    const bot = bots[seatOf[seat]!]!;
    const action = bot(observe(state, seat), legalActionIds(state), rng);
    const tally = bySeat[seat]!;
    switch (action.type) {
      // Shells are tallied off the EVENTS below: one SPRAY lands up to four.
      case 'FIRE': tally.apSpent += AP_COST.FIRE; break;
      case 'SPRAY': case 'FORK': case 'SCAN': case 'ECHO':
        tally.tools++;
        toolsByKind[seat]![action.type]++;
        tally.apSpent += toolCost(action.type);
        break;
      // Priced off the live state before the sweep lands (pingEscalates varies it).
      case 'PING': {
        const cost = pingCostFor(config, n, state.pingsThisTurn);
        tally.pings++;
        tally.apSpent += cost;
        tally.apOnPings += cost;
        if (state.pingsThisTurn > 0) tally.extraPings++;
        break;
      }
      case 'MOVE': tally.moves++; tally.apSpent += AP_COST.MOVE; break;
      case 'DECOY': tally.decoys++; tally.apSpent += AP_COST.DECOY; tally.decoyTurns.push(state.turn); break;
      case 'PASS': tally.passes++; break;
    }

    // Read off the board as it stood when the trigger was pulled, before anything lands.
    const aimed = action.type === 'FIRE' || action.type === 'SPRAY';
    const weakest = aimed ? weakestSeat(hullDownOf(state)) : null;

    const result = step(state, action, rng);
    let sankSomething = false;
    for (const e of result.events) {
      if (e.type === 'fire') {
        const by = e.by!;
        shotsAt[by]![e.target]! += 1;
        // Every shell counts once, however it was paid for.
        bySeat[by]!.shots++;
        cellsShot[by]!.add(e.cell);
        // Bystanders only: the weakest seat cannot shoot itself.
        if (weakest !== null && by !== weakest) {
          shotsWithStrictWeakest[by]! += 1;
          if (e.target === weakest) shotsAtWeakest[by]! += 1;
        }
        if (e.reported === 'HIT' || e.reported === 'SUNK') bySeat[by]!.reportedHits++;
        if (e.sunkShip) sankSomething = true;
        if (e.hitShip) {
          bySeat[by]!.realHits++;
          damage[by]![e.target]! += 1;
          firstBloodVictim ??= e.target;
        }
      } else if (e.type === 'decoySpent') {
        // Credit the board's owner, read off the event.
        bySeat[e.player]!.fakeHitsAbsorbed++;
      } else if (e.type === 'turnStarted') {
        bySeat[e.player]!.apGranted += e.budget;
        bySeat[e.player]!.budgetByRound.push(e.budget);
        if (e.budget < AP_COST.FIRE) bySeat[e.player]!.disarmedTurns++;
      }
    }
    state = result.state;
    // Only a sinking can move a low-water mark, so this costs nothing on a normal shell.
    if (sankSomething) {
      unsunkOf(state).forEach((u, seat) => { lowWater[seat] = Math.min(lowWater[seat]!, u); });
    }
  }

  for (let seat = 0; seat < n; seat++) bySeat[seat]!.distinctCellsShot = cellsShot[seat]!.size;

  const winnerSeat = state.phase.kind === 'won' ? state.phase.winner : null;
  // The shot log is chronological: the first SUNK that empties a board is the first
  // elimination. A draw leaves this null.
  const afloat = unsunkOf(state);
  let firstKill: { seat: PlayerId; by: PlayerId } | null = null;
  const sunkCount = new Array<number>(n).fill(0);
  for (const shot of state.shots) {
    if (shot.result !== 'SUNK') continue;
    sunkCount[shot.target]! += 1;
    if (sunkCount[shot.target]! === FLEET.length) {
      firstKill = { seat: shot.target, by: shot.by };
      break;
    }
  }
  const victimSeat = afloat.some((u) => u === 0) ? (firstKill?.seat ?? null) : null;
  const eliminator = victimSeat === null ? null : (firstKill?.by ?? null);

  return {
    seed,
    seatOf: [...seatOf],
    winnerSeat,
    victimSeat: victimSeat === -1 ? null : victimSeat,
    eliminatorSeat: eliminator,
    firstBloodVictim,
    turns: state.turn,
    damage,
    shotsAt,
    shotsAtWeakest,
    shotsWithStrictWeakest,
    lowWater,
    bySeat,
    toolsByKind,
  };
}

// Every assignment of `n` bots to `n` seats, in a stable order.
function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let i = 0; i < n; i++) out.push([...rest.slice(0, i), n - 1, ...rest.slice(i)]);
  }
  return out.sort((a, b) => a.join().localeCompare(b.join()));
}

export interface MeleeBatchOptions {
  games: number;
  baseSeed: number;
  // Cycle all n! seatings instead of the n rotations. Costlier, fully seat-balanced.
  allPerms?: boolean;
  onProgress?: (done: number, total: number) => void;
}

// Rotate bots through seats so neither seat order nor opening advantage favours anyone.
export function runMeleeBatch(
  bots: Bot[],
  config: GameConfig,
  opts: MeleeBatchOptions,
): MeleeRecord[] {
  const n = bots.length;
  const seatings = opts.allPerms
    ? permutations(n)
    : Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, seat) => (seat + r) % n));
  const records: MeleeRecord[] = [];
  for (let i = 0; i < opts.games; i++) {
    records.push(runMeleeGame(bots, config, opts.baseSeed + i, seatings[i % seatings.length]!));
    opts.onProgress?.(i + 1, opts.games);
  }
  return records;
}
