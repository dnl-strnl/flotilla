import {
  AP_COST,
  createGame,
  legalActionIds,
  mulberry32,
  observe,
  randomFleet,
  step,
  type GameConfig,
  type PlayerId,
} from '../engine';
import type { Bot } from '../ai/types';

// Per-side tallies for one game. Sides are labeled by BOT (A/B), not seat.
export interface SideStats {
  shots: number;
  // Special-tool uses (not shells). Melee-only; always 0 through run.ts.
  tools: number;
  pings: number;
  // Sweeps that were NOT the first of their turn — the ones `pingEscalates` surcharges.
  extraPings: number;
  moves: number;
  decoys: number;
  passes: number;
  // HIT/SUNK results as reported to this bot (decoy fakes included).
  reportedHits: number;
  // Actual ship-segment hits scored by this bot.
  realHits: number;
  // Enemy shots absorbed by THIS side's decoys.
  fakeHitsAbsorbed: number;
  apGranted: number;
  apSpent: number;
  apOnPings: number;
  // Distinct enemy cells ever fired at — near 100 means the board was exhausted.
  distinctCellsShot: number;
  // Turns this side began with a budget too small to afford a FIRE.
  disarmedTurns: number;
  // Turn numbers at which this side placed decoys.
  decoyTurns: number[];
  // AP budget at each of this side's turns, in order (AP economy curve).
  budgetByRound: number[];
}

export interface GameRecord {
  seed: number;
  // Which seat bot A occupied this game (0 moves first).
  aSeat: PlayerId;
  winner: 'A' | 'B' | 'draw';
  firstPlayerWon: boolean | null;
  turns: number;
  a: SideStats;
  b: SideStats;
}

export function emptySide(): SideStats {
  return {
    shots: 0, tools: 0, pings: 0, extraPings: 0, moves: 0, decoys: 0, passes: 0,
    reportedHits: 0, realHits: 0, fakeHitsAbsorbed: 0,
    apGranted: 0, apSpent: 0, apOnPings: 0,
    distinctCellsShot: 0, disarmedTurns: 0,
    decoyTurns: [], budgetByRound: [],
  };
}

// Run one full headless game. Deterministic for a given (bots, config, seed, aSeat): one
// seeded RNG drives placements, bot decisions, everything.
export function runGame(
  botA: Bot,
  botB: Bot,
  config: GameConfig,
  seed: number,
  aSeat: PlayerId = 0,
): GameRecord {
  const rng = mulberry32(seed);
  let state = createGame(config, [randomFleet(rng), randomFleet(rng)], seed);
  const bySeat: [SideStats, SideStats] = [emptySide(), emptySide()];
  const cellsShot: [Set<number>, Set<number>] = [new Set(), new Set()];
  bySeat[state.activePlayer]!.apGranted += state.budget;
  bySeat[state.activePlayer]!.budgetByRound.push(state.budget);
  if (state.budget < AP_COST.FIRE) bySeat[state.activePlayer]!.disarmedTurns++;

  let guard = 0;
  while (state.phase.kind === 'playing' && guard++ < 20000) {
    const seat = state.activePlayer;
    const bot = seat === aSeat ? botA : botB;
    const action = bot(observe(state, seat), legalActionIds(state), rng);
    const tally = bySeat[seat]!;
    switch (action.type) {
      case 'FIRE': tally.shots++; tally.apSpent += AP_COST.FIRE; cellsShot[seat]!.add(action.cell); break;
      case 'PING': tally.pings++; tally.apSpent += AP_COST.PING; tally.apOnPings += AP_COST.PING; break;
      case 'MOVE': tally.moves++; tally.apSpent += AP_COST.MOVE; break;
      case 'DECOY': tally.decoys++; tally.apSpent += AP_COST.DECOY; tally.decoyTurns.push(state.turn); break;
      case 'PASS': tally.passes++; break;
    }

    const result = step(state, action, rng);
    for (const e of result.events) {
      if (e.type === 'fire') {
        // Engine output is unredacted, so `by` and `target` are always present here.
        const by = e.by!;
        if (e.reported === 'HIT' || e.reported === 'SUNK') bySeat[by]!.reportedHits++;
        if (e.hitShip) bySeat[by]!.realHits++;
        // Credit the decoy to whoever OWNS the board that was fired at.
        if (e.decoy) bySeat[e.target]!.fakeHitsAbsorbed++;
      } else if (e.type === 'turnStarted') {
        bySeat[e.player]!.apGranted += e.budget;
        bySeat[e.player]!.budgetByRound.push(e.budget);
        if (e.budget < AP_COST.FIRE) bySeat[e.player]!.disarmedTurns++;
      }
    }
    state = result.state;
  }

  bySeat[0]!.distinctCellsShot = cellsShot[0].size;
  bySeat[1]!.distinctCellsShot = cellsShot[1].size;

  const bSeat: PlayerId = aSeat === 0 ? 1 : 0;
  const winner =
    state.phase.kind === 'won' ? (state.phase.winner === aSeat ? 'A' : 'B') : 'draw';
  return {
    seed,
    aSeat,
    winner,
    firstPlayerWon: state.phase.kind === 'won' ? state.phase.winner === 0 : null,
    turns: state.turn,
    a: bySeat[aSeat]!,
    b: bySeat[bSeat]!,
  };
}

export interface BatchOptions {
  games: number;
  baseSeed: number;
  // Alternate which bot moves first each game (default true).
  alternateSeats?: boolean;
  onProgress?: (done: number, total: number) => void;
}

// Run K games, alternating seats, reporting progress. Pure apart from onProgress.
export function runBatch(botA: Bot, botB: Bot, config: GameConfig, opts: BatchOptions): GameRecord[] {
  const records: GameRecord[] = [];
  const alternate = opts.alternateSeats ?? true;
  for (let i = 0; i < opts.games; i++) {
    const aSeat: PlayerId = alternate && i % 2 === 1 ? 1 : 0;
    records.push(runGame(botA, botB, config, opts.baseSeed + i, aSeat));
    opts.onProgress?.(i + 1, opts.games);
  }
  return records;
}
