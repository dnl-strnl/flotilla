import { AP_COST, FLEET, type GameConfig } from '../engine';
import type { GameRecord, SideStats } from './run';
import type { MeleeRecord } from './melee';

// 95% Wilson score interval for a binomial proportion.
export function wilson95(wins: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.959964;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface BotAggregate {
  shotsPerGame: number;
  // Special-tool uses per game. Always 0 in a duel.
  toolsPerGame: number;
  pingsPerGame: number;
  // Share of this bot's sweeps that were a turn's second-or-later (what pingEscalates
  // hits).
  extraPingShare: number;
  movesPerGame: number;
  decoysPerGame: number;
  passesPerGame: number;
  // reported hits / shots (what the bot believes).
  reportedAccuracy: number;
  // real hits / shots (ground truth).
  realAccuracy: number;
  pingApShare: number;
  // fake hits absorbed / decoys placed (decoy effectiveness).
  fakeHitsPerDecoy: number;
  meanDecoyTurn: number | null;
  // Avg distinct enemy cells fired at per game (→100 = board exhausted).
  distinctCellsPerGame: number;
  // Share of games where this bot shot ≥90 distinct cells without winning.
  boardExhaustedRate: number;
  // Avg turns per game begun unable to afford a FIRE.
  disarmedTurnsPerGame: number;
  // Average AP budget at round r (this bot's r-th turn), for the economy curve.
  apCurve: number[];
}

export interface Aggregate {
  games: number;
  winsA: number;
  winsB: number;
  draws: number;
  winRateA: number;
  ciA: { lo: number; hi: number };
  // First-player advantage: wins by whichever bot moved first (decided games).
  firstPlayerWins: number;
  decidedGames: number;
  firstPlayerRate: number;
  ciFirst: { lo: number; hi: number };
  meanTurns: number;
  medianTurns: number;
  // Histogram of game length in 10-turn buckets: index i = turns in [10i, 10i+10).
  lengthHistogram: number[];
  a: BotAggregate;
  b: BotAggregate;
  flags: string[];
}

function aggregateSide(sides: SideStats[], games: number, lost: boolean[]): BotAggregate {
  const sum = (f: (s: SideStats) => number) => sides.reduce((acc, s) => acc + f(s), 0);
  const shots = sum((s) => s.shots);
  const decoys = sum((s) => s.decoys);
  const apSpent = sum((s) => s.apSpent);
  const decoyTurns = sides.flatMap((s) => s.decoyTurns);
  const maxRounds = Math.max(0, ...sides.map((s) => s.budgetByRound.length));
  const apCurve: number[] = [];
  for (let r = 0; r < maxRounds; r++) {
    const vals = sides.filter((s) => s.budgetByRound.length > r).map((s) => s.budgetByRound[r]!);
    apCurve.push(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return {
    shotsPerGame: shots / games,
    toolsPerGame: sum((s) => s.tools) / games,
    pingsPerGame: sum((s) => s.pings) / games,
    extraPingShare: sum((s) => s.pings) ? sum((s) => s.extraPings) / sum((s) => s.pings) : 0,
    movesPerGame: sum((s) => s.moves) / games,
    decoysPerGame: decoys / games,
    passesPerGame: sum((s) => s.passes) / games,
    reportedAccuracy: shots ? sum((s) => s.reportedHits) / shots : 0,
    realAccuracy: shots ? sum((s) => s.realHits) / shots : 0,
    pingApShare: apSpent ? sum((s) => s.apOnPings) / apSpent : 0,
    fakeHitsPerDecoy: decoys ? sum((s) => s.fakeHitsAbsorbed) / decoys : 0,
    meanDecoyTurn: decoyTurns.length
      ? decoyTurns.reduce((a, b) => a + b, 0) / decoyTurns.length
      : null,
    distinctCellsPerGame: sum((s) => s.distinctCellsShot) / games,
    boardExhaustedRate:
      sides.filter((s, i) => s.distinctCellsShot >= 90 && lost[i]).length / games,
    disarmedTurnsPerGame: sum((s) => s.disarmedTurns) / games,
    apCurve,
  };
}

export function aggregate(records: GameRecord[], config: GameConfig): Aggregate {
  const games = records.length;
  const winsA = records.filter((r) => r.winner === 'A').length;
  const winsB = records.filter((r) => r.winner === 'B').length;
  const draws = records.filter((r) => r.winner === 'draw').length;
  const decided = records.filter((r) => r.firstPlayerWon !== null);
  const firstPlayerWins = decided.filter((r) => r.firstPlayerWon).length;

  const turns = records.map((r) => r.turns).sort((x, y) => x - y);
  const lengthHistogram: number[] = [];
  for (const t of turns) {
    const bucket = Math.floor(t / 10);
    lengthHistogram[bucket] = (lengthHistogram[bucket] ?? 0) + 1;
  }
  for (let i = 0; i < lengthHistogram.length; i++) lengthHistogram[i] = lengthHistogram[i] ?? 0;

  // Board exhaustion only counts as a symptom when the bot didn't win.
  const a = aggregateSide(records.map((r) => r.a), games, records.map((r) => r.winner !== 'A'));
  const b = aggregateSide(records.map((r) => r.b), games, records.map((r) => r.winner !== 'B'));

  const flags: string[] = [];
  if (draws > 0) flags.push(`DRAWS: ${draws} game(s) hit the turn cap`);
  for (const [name, agg] of [['A', a], ['B', b]] as const) {
    if (config.movement && agg.movesPerGame < 0.5) {
      flags.push(`NEVER-MOVES: bot ${name} averages ${agg.movesPerGame.toFixed(2)} moves/game`);
    }
    if (config.pings && agg.pingApShare > 0.4) {
      flags.push(`PING-SPAM: bot ${name} spends ${(agg.pingApShare * 100).toFixed(0)}% of AP on pings`);
    }
    if (
      config.decoys &&
      agg.decoysPerGame >= 1.5 &&
      agg.meanDecoyTurn !== null &&
      agg.meanDecoyTurn < 5
    ) {
      flags.push(`DECOY-RUSH: bot ${name} dumps decoys by turn ${agg.meanDecoyTurn.toFixed(1)}`);
    }
    if (config.movement && agg.boardExhaustedRate > 0.02) {
      flags.push(
        `STALE-LOCKOUT: bot ${name} exhausted the board (≥90 distinct cells) without winning in ` +
          `${(agg.boardExhaustedRate * 100).toFixed(1)}% of games — stale MISS markers hiding live cells`,
      );
    }
    if (agg.disarmedTurnsPerGame > 2) {
      flags.push(
        `DISARMED: bot ${name} averages ${agg.disarmedTurnsPerGame.toFixed(1)} turns/game ` +
          `with a budget too small to afford a ${AP_COST.FIRE}-AP shot`,
      );
    }
  }

  return {
    games,
    winsA,
    winsB,
    draws,
    winRateA: games ? winsA / games : 0,
    ciA: wilson95(winsA, games),
    firstPlayerWins,
    decidedGames: decided.length,
    firstPlayerRate: decided.length ? firstPlayerWins / decided.length : 0,
    ciFirst: wilson95(firstPlayerWins, decided.length),
    meanTurns: games ? turns.reduce((x, y) => x + y, 0) / games : 0,
    medianTurns: games ? turns[Math.floor(games / 2)]! : 0,
    lengthHistogram,
    a,
    b,
    flags,
  };
}

// Flatten per-game records to CSV (one row per game).
export function recordsToCsv(records: GameRecord[]): string {
  const sideCols = (p: 'a' | 'b') =>
    ['shots', 'pings', 'moves', 'decoys', 'passes', 'reportedHits', 'realHits',
      'fakeHitsAbsorbed', 'apGranted', 'apSpent', 'distinctCellsShot',
      'disarmedTurns'].map((c) => `${p}_${c}`);
  const header = ['seed', 'aSeat', 'winner', 'turns', ...sideCols('a'), ...sideCols('b')];
  const rows = records.map((r) => [
    r.seed, r.aSeat, r.winner, r.turns,
    r.a.shots, r.a.pings, r.a.moves, r.a.decoys, r.a.passes, r.a.reportedHits,
    r.a.realHits, r.a.fakeHitsAbsorbed, r.a.apGranted, r.a.apSpent,
    r.a.distinctCellsShot, r.a.disarmedTurns,
    r.b.shots, r.b.pings, r.b.moves, r.b.decoys, r.b.passes, r.b.reportedHits,
    r.b.realHits, r.b.fakeHitsAbsorbed, r.b.apGranted, r.b.apSpent,
    r.b.distinctCellsShot, r.b.disarmedTurns,
  ]);
  return [header.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

// Three-way aggregation. The unit is win SHARE against a neutral 1/n per seat and bot.
export interface MeleeAggregate {
  games: number;
  decided: number;
  draws: number;
  meanTurns: number;
  medianTurns: number;
  // Per bot and per seat: wins, share of all games, and the Wilson interval on that share.
  byBot: { wins: number; share: number; ci: { lo: number; hi: number } }[];
  bySeat: { wins: number; share: number; ci: { lo: number; hi: number } }[];
  botStats: BotAggregate[];
  // Share of the damage on the FIRST fleet to die that the eventual winner dealt, averaged
  // over decided games.
  killSteal: number;
  // P(the seat that scored the first kill goes on to win).
  firstKillWins: number;
  // P(the first fleet to take a real hit is the fleet that dies) — does damage snowball?
  snowballToVictim: number;
  // P(the first fleet to take a real hit goes on to WIN) — is drawing fire survivable?
  firstBloodWins: number;
  // Share of shells aimed at the single most-damaged fleet at the moment of firing. Fair
  // is 1/(n-1); above that the field gangs up on whoever is bleeding.
  focusIndex: number;
  // P(the fleet that died was double-teamed: BOTH its opponents sent it most of their
  // shells).
  doubleTeamRate: number;
  // P(win | this seat was reduced to k unsunk ships at some point), index k = 0..FLEET.
  // null where no seat ever bottomed out at k.
  comebackByLowWater: (number | null)[];
  flags: string[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function aggregateMelee(records: MeleeRecord[], botCount: number): MeleeAggregate {
  const games = records.length;
  const decidedRecs = records.filter((r) => r.winnerSeat !== null);
  const turns = records.map((r) => r.turns);

  const botWins = new Array<number>(botCount).fill(0);
  const seatWins = new Array<number>(botCount).fill(0);
  for (const r of decidedRecs) {
    botWins[r.seatOf[r.winnerSeat!]!]! += 1;
    seatWins[r.winnerSeat!]! += 1;
  }
  const tally = (wins: number[]) =>
    wins.map((w) => ({ wins: w, share: games ? w / games : 0, ci: wilson95(w, games) }));

  // Per-bot usage: pool each bot's seats across the games it played them in.
  const botStats = Array.from({ length: botCount }, (_, bot) => {
    const sides: SideStats[] = [];
    const lost: boolean[] = [];
    for (const r of records) {
      const seat = r.seatOf.indexOf(bot);
      if (seat < 0) continue;
      sides.push(r.bySeat[seat]!);
      lost.push(r.winnerSeat !== seat);
    }
    return aggregateSide(sides, Math.max(1, sides.length), lost);
  });

  let stealSum = 0;
  let stealN = 0;
  for (const r of decidedRecs) {
    if (r.victimSeat === null) continue;
    const total = r.damage.reduce((a, row) => a + row[r.victimSeat!]!, 0);
    if (total === 0) continue;
    stealSum += r.damage[r.winnerSeat!]![r.victimSeat!]! / total;
    stealN++;
  }

  // Records without an eliminator drop out of the rate.
  const killRecs = decidedRecs.filter((r) => r.eliminatorSeat !== null && r.eliminatorSeat !== undefined);
  const killConverted = killRecs.filter((r) => r.eliminatorSeat === r.winnerSeat).length;

  const bloodRecs = records.filter((r) => r.firstBloodVictim !== null);
  const snowball = bloodRecs.filter((r) => r.firstBloodVictim === r.victimSeat).length;
  const bloodWins = bloodRecs.filter((r) => r.firstBloodVictim === r.winnerSeat).length;

  // A missing aim field means "not measured", not zero.
  let atWeakest = 0;
  let withWeakest = 0;
  for (const r of records) {
    for (const x of r.shotsAtWeakest ?? []) atWeakest += x;
    for (const x of r.shotsWithStrictWeakest ?? []) withWeakest += x;
  }

  let doubleTeamed = 0;
  for (const r of decidedRecs) {
    if (r.victimSeat === null || !r.shotsAt) continue;
    const foes = r.shotsAt.map((_, seat) => seat).filter((seat) => seat !== r.victimSeat);
    const pressed = foes.filter((foe) => {
      const row = r.shotsAt[foe]!;
      const fired = row.reduce((a, b) => a + b, 0);
      return fired > 0 && row[r.victimSeat!]! / fired > 0.5;
    });
    if (pressed.length === foes.length) doubleTeamed++;
  }

  // One (game, seat) pair per entry: a seat that bottomed out at k, and whether it won.
  const lowSeen = new Array<number>(FLEET.length + 1).fill(0);
  const lowWon = new Array<number>(FLEET.length + 1).fill(0);
  for (const r of records) {
    (r.lowWater ?? []).forEach((k, seat) => {
      if (k < 0 || k >= lowSeen.length) return;
      lowSeen[k]! += 1;
      if (r.winnerSeat === seat) lowWon[k]! += 1;
    });
  }

  const flags: string[] = [];
  const draws = games - decidedRecs.length;
  if (draws > 0) flags.push(`DRAWS: ${draws} game(s) hit the turn cap`);
  const even = 1 / botCount;
  tally(botWins).forEach((b, i) => {
    // A bot whose whole interval sits above parity is dominating the mode, not just
    // winning.
    if (b.ci.lo > even) flags.push(`DOMINANT: bot ${i} share ${(b.share * 100).toFixed(1)}% (CI excludes ${(even * 100).toFixed(0)}%)`);
  });
  tally(seatWins).forEach((s, i) => {
    if (s.ci.lo > even) flags.push(`SEAT BIAS: seat ${i} wins ${(s.share * 100).toFixed(1)}% (CI excludes ${(even * 100).toFixed(0)}%)`);
  });
  // Flagged well above the fair share: some focus on a cripple is correct play.
  const fairFocus = 1 / Math.max(1, botCount - 1);
  if (withWeakest > 0 && atWeakest / withWeakest > fairFocus * 1.4) {
    flags.push(
      `GANG-UP: ${((atWeakest / withWeakest) * 100).toFixed(1)}% of shells went at the ` +
        `most-damaged fleet against a fair ${(fairFocus * 100).toFixed(0)}%`,
    );
  }

  return {
    games,
    decided: decidedRecs.length,
    draws,
    meanTurns: games ? turns.reduce((a, b) => a + b, 0) / games : 0,
    medianTurns: median(turns),
    byBot: tally(botWins),
    bySeat: tally(seatWins),
    botStats,
    killSteal: stealN ? stealSum / stealN : 0,
    firstKillWins: killRecs.length ? killConverted / killRecs.length : 0,
    snowballToVictim: bloodRecs.length ? snowball / bloodRecs.length : 0,
    firstBloodWins: bloodRecs.length ? bloodWins / bloodRecs.length : 0,
    focusIndex: withWeakest ? atWeakest / withWeakest : 0,
    doubleTeamRate: decidedRecs.length ? doubleTeamed / decidedRecs.length : 0,
    comebackByLowWater: lowSeen.map((seen, k) => (seen ? lowWon[k]! / seen : null)),
    flags,
  };
}
