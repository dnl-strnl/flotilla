// Headless simulation CLI (balance lab). Flags documented in README "Simulation lab". npm
// run simulate -- --a commander --b ensign --preset CLASSIC --games 500
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PRESETS, type PresetName, type ToolId } from '../engine';
import { makeBot, makeMelee, type BotName } from '../ai';
import { runBatch, type GameRecord } from './run';
import { runMeleeBatch, type MeleeRecord } from './melee';
import { aggregate, aggregateMelee, recordsToCsv } from './stats';

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.set(arg.slice(2), next);
        i++;
      } else {
        args.set(arg.slice(2), 'true');
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const HELP = `npm run simulate -- [flags]
  --a <bot> --b <bot>     duel seats (default commander vs ensign)
  --c <bot>               a third seat: the run becomes a MELEE
  --preset <name>         CLASSIC | SALVO | FLOTILLA (default)
  --games <n> --seed <n>  batch size (default 1000) and base seed (default 1)
  --samples <n>           Monte Carlo samples per decision (default 300)
  --shards <n>            split across child processes, bit-identical to serial
  --json <file> --csv <file>
  rules:    --pingEscalates [false]  --finalDuelFullAp [false]
  MELEE:    --perms  --targetTemp <t>  --commitTurn  --denyA/B/C <TOOL,...>
            --turnPlan false  --litPull false
bots: ensign lieutenant commander captain commodore admiral`;
if (args.has('help')) {
  console.log(HELP);
  process.exit(0);
}
const botAName = (args.get('a') ?? 'commander') as BotName;
const botBName = (args.get('b') ?? 'ensign') as BotName;
const presetName = (args.get('preset') ?? 'FLOTILLA').toUpperCase() as PresetName;
const games = Math.min(10000, Math.max(1, Number(args.get('games') ?? 1000)));
const seed = Number(args.get('seed') ?? 1);
const samples = Number(args.get('samples') ?? 300);

// Rules settled as fixed v0.1.0 mechanics; fail loudly rather than run an A/B that silently
// ignores the flag.
const RETIRED = ['moveCost', 'pingSize', 'sonarLiveOnly', 'makoSprint', 'moveWake', 'moveCooldown', 'decoyPingOnce'];
for (const flag of RETIRED) {
  if (args.has(flag)) {
    console.error(`--${flag} was removed: it is a fixed rule now, not a knob`);
    process.exit(1);
  }
}
// A typo'd flag would otherwise run the default A/B and look like a result.
const KNOWN = new Set([
  'a', 'b', 'c', 'preset', 'games', 'seed', 'samples', 'shards', 'shard-out', 'json', 'csv', 'perms',
  'pingEscalates', 'finalDuelFullAp', 'targetTemp', 'commitTurn', 'denyA', 'denyB', 'denyC',
  'turnPlan', 'litPull', 'doctrine',
]);
for (const flag of args.keys()) {
  if (!KNOWN.has(flag)) {
    console.error(`unknown flag --${flag} (see --help)`);
    process.exit(1);
  }
}

const preset = PRESETS[presetName];
if (!preset) {
  console.error(`unknown preset: ${presetName}`);
  process.exit(1);
}
const config = {
  ...preset,
  ...(args.has('pingEscalates') ? { pingEscalates: args.get('pingEscalates') !== 'false' } : {}),
  ...(args.has('finalDuelFullAp') ? { finalDuelFullAp: args.get('finalDuelFullAp') !== 'false' } : {}),
};

// --c turns the run into a MELEE; absent, it is a two-player run.
const botCName = args.get('c') as BotName | undefined;
const meleeNames = botCName ? [botAName, botBName, botCName] : [];
// Target choice is part of each rank (see chooseTarget in ai/melee.ts).
if (args.has('doctrine')) {
  console.error('--doctrine was removed: each rank has one built-in target rule');
  process.exit(1);
}
// Score target choice off the board as it stood when the turn opened. See freezeIntel.
const commitTurn = args.has('commitTurn') && args.get('commitTurn') !== 'false';
// Softmax temperature for melee target selection; 0 = the argmax that ships.
const targetTemp = Number(args.get('targetTemp') ?? 0);
if (!Number.isFinite(targetTemp) || targetTemp < 0) {
  console.error(`targetTemp must be a non-negative number, got ${args.get('targetTemp')}`);
  process.exit(1);
}

const botA = makeBot(botAName, { samples });
const botB = makeBot(botBName, { samples });

// Games are seeded by `baseSeat + i`, so a run shards exactly — provided each shard starts
// at an even offset, since runBatch alternates seats on the batch-local index.
function splitGames(total: number, shards: number, multiple = 2): number[] {
  const per = Math.max(multiple, Math.ceil(total / shards / multiple) * multiple);
  const out: number[] = [];
  for (let left = total; left > 0; ) {
    const take = Math.min(per, left);
    out.push(take);
    left -= take;
  }
  return out;
}

// Re-invoke this very CLI once per shard and merge the records back.
function runSharded<T>(chunks: number[]): Promise<T[]> {
  const runner = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const self = path.resolve(process.cwd(), 'src/sim/cli.ts');
  const passthrough = process.argv.slice(2).filter((a, i, all) => {
    const prev = all[i - 1];
    const drop = ['--games', '--seed', '--shards', '--json', '--csv', '--shard-out'];
    return !drop.includes(a) && !(prev !== undefined && drop.includes(prev));
  });
  let offset = 0;
  let done = 0;
  const jobs = chunks.map((count) => {
    const out = path.join(tmpdir(), `flotilla-shard-${process.pid}-${offset}.json`);
    const argv = [self, ...passthrough, '--games', String(count), '--seed', String(seed + offset), '--shard-out', out];
    offset += count;
    return new Promise<T[]>((resolve, reject) => {
      const child = spawn(existsSync(runner) ? runner : 'npx', existsSync(runner) ? argv : ['tsx', ...argv], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) return reject(new Error(`shard exited ${code}`));
        const recs = JSON.parse(readFileSync(out, 'utf8')) as T[];
        rmSync(out, { force: true });
        done += recs.length;
        process.stderr.write(`\r  shards: ${done}/${games} games`);
        resolve(recs);
      });
    });
  });
  return Promise.all(jobs).then((all) => all.flat());
}

const shardOut = args.get('shard-out');
const shards = Math.max(1, Math.min(32, Number(args.get('shards') ?? 1)));

// Rounds sampled from apCurve for the printed economy curve; the full series rides in
// --json.
const AP_ROUNDS = [1, 5, 10, 15, 20, 25, 30, 40];

// ── MELEE (three-way) ────────────────────────────────────────────────────────────────
if (botCName) {
  const allPerms = args.get('perms') === 'true';
  const label = (i: number) =>
    meleeNames[i]!.toUpperCase() + (args.get(`deny${'ABC'[i]}`) ? ` -${args.get(`deny${'ABC'[i]}`)}` : '');
  const denyOf = (i: number) =>
    (args.get(`deny${'ABC'[i]}`)?.split(',').filter(Boolean) ?? []) as ToolId[];
  // Ablations of ADMIRAL's whole-turn planning and the lit-board pull; both ship on.
  const turnPlan = args.get('turnPlan') !== 'false';
  const litPull = args.get('litPull') !== 'false';
  const meleeBots = meleeNames.map((name, i) =>
    makeMelee(name, { samples, targetTemp, commitTurn, denyTools: denyOf(i), turnPlan, litPull }));
  // Seat rotation repeats every 3 games (6 with --perms), so shards must start on a
  // boundary or the seat balance skews.
  const cycle = allPerms ? 6 : meleeBots.length;

  console.error(
    shardOut
      ? ''
      : `FLOTILLA SIM MELEE ▸ ${meleeNames.map((_, i) => label(i)).join(' vs ')} ▸ ${presetName} ▸ ${games} games ▸ seed ${seed}${shards > 1 ? ` ▸ ${shards} shards` : ''}`,
  );
  const t0 = Date.now();
  const recs =
    shards > 1 && !shardOut
      ? await runSharded<MeleeRecord>(splitGames(games, shards, cycle))
      : runMeleeBatch(meleeBots, config, {
          games,
          baseSeed: seed,
          allPerms,
          onProgress: (done, total) => {
            if (shardOut) return;
            if (done % Math.max(1, Math.floor(total / 50)) === 0 || done === total) {
              const width = 30;
              const filled = Math.round((done / total) * width);
              process.stderr.write(`\r[${'▰'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`);
            }
          },
        });
  process.stderr.write('\n');

  if (shardOut) {
    writeFileSync(shardOut, JSON.stringify(recs));
    process.exit(0);
  }

  const m = aggregateMelee(recs, meleeBots.length);
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  const out = [
    '',
    `RESULTS (${m.games} games, ${((Date.now() - t0) / 1000).toFixed(1)}s) — win SHARE, even split would be ${p(1 / meleeBots.length)}`,
    ...m.byBot.map((b, i) => `  ${label(i).padEnd(22)} ${String(b.wins).padStart(4)} wins  ${p(b.share).padStart(6)}  CI ${p(b.ci.lo)}–${p(b.ci.hi)}`),
    `  draws: ${m.draws}   game length: mean ${m.meanTurns.toFixed(1)} turns, median ${m.medianTurns}`,
    '',
    `  seat shares (opening bias): ${m.bySeat.map((s, i) => `P${i + 1} ${p(s.share)}`).join('  ')}`,
    `  kill-steal index: ${p(m.killSteal)} of the first dead fleet's damage was dealt by the winner`,
    `  first kill converted: ${p(m.firstKillWins)} of games were won by the seat that opened` +
      ` the scoring (first-kill-wins would have crowned them on the spot)`,
    `  snowball: first fleet hit dies ${p(m.snowballToVictim)} of the time, wins ${p(m.firstBloodWins)}`,
    `  focus index: ${p(m.focusIndex)} of shells went at the most-damaged fleet (fair ${p(1 / (meleeBots.length - 1))})`,
    `  double-teamed: ${p(m.doubleTeamRate)} of dead fleets took most of BOTH opponents' shells`,
    `  comeback — P(win | reduced to k ships): ${m.comebackByLowWater
      .map((v, k) => (v === null ? null : `${k}:${p(v)}`))
      .filter(Boolean)
      .reverse()
      .join('  ')}`,
    '',
    `  per-game usage       shells   tools   pings  2nd+/ping  pingAP   moves  decoys  acc(real)   cells`,
    ...m.botStats.map((s, i) =>
      `  ${label(i).padEnd(18)} ${s.shotsPerGame.toFixed(1).padStart(6)} ${s.toolsPerGame.toFixed(2).padStart(7)} ${s.pingsPerGame.toFixed(1).padStart(7)} ${p(s.extraPingShare).padStart(10)} ${p(s.pingApShare).padStart(7)} ${s.movesPerGame.toFixed(1).padStart(7)} ${s.decoysPerGame.toFixed(2).padStart(7)} ${p(s.realAccuracy).padStart(10)} ${s.distinctCellsPerGame.toFixed(1).padStart(7)}`,
    ),
    `  tools/game by kind    ${['SCAN', 'ECHO', 'FORK', 'SPRAY'].map((k) => k.padStart(7)).join('')}`,
    ...meleeNames.map((_, i) => {
      const per = (k: string) => {
        let sum = 0;
        for (const r of recs) {
          const seat = r.seatOf.indexOf(i);
          sum += r.toolsByKind?.[seat]?.[k] ?? 0;
        }
        return (sum / recs.length).toFixed(2).padStart(7);
      };
      return `  ${label(i).padEnd(18)}    ${['SCAN', 'ECHO', 'FORK', 'SPRAY'].map(per).join('')}`;
    }),
    '',
    `  AP economy (mean budget at round)   ${AP_ROUNDS.map((r) => `r${r}`.padStart(6)).join('')}`,
    ...m.botStats.map((s, i) =>
      `  ${label(i).padEnd(18)} ${AP_ROUNDS.map((r) => {
        const v = s.apCurve[r - 1];
        return (v === undefined ? '—' : v.toFixed(2)).padStart(6);
      }).join('')}`,
    ),
    '',
    m.flags.length ? `  FLAGS:\n${m.flags.map((f) => `   ⚠ ${f}`).join('\n')}` : '  no degenerate findings',
    '',
  ];
  console.log(out.join('\n'));

  const mJson = args.get('json');
  if (mJson) {
    writeFileSync(mJson, JSON.stringify({ meta: { bots: meleeNames, deny: meleeNames.map((_, i) => denyOf(i)), preset: presetName, games, seed, samples }, aggregate: m, records: recs }, null, 2));
    console.error(`wrote ${mJson}`);
  }
  process.exit(0);
}

console.error(
  shardOut
    ? ''
    : `FLOTILLA SIM ▸ ${botAName} (A) vs ${botBName} (B) ▸ ${presetName} ▸ ${games} games ▸ seed ${seed}${shards > 1 ? ` ▸ ${shards} shards` : ''}`,
);
const started = Date.now();
const records =
  shards > 1 && !shardOut
    ? await runSharded<GameRecord>(splitGames(games, shards))
    : runBatch(botA, botB, config, {
        games,
        baseSeed: seed,
        onProgress: (done, total) => {
          if (shardOut) return;
          if (done % Math.max(1, Math.floor(total / 50)) === 0 || done === total) {
            const width = 30;
            const filled = Math.round((done / total) * width);
            process.stderr.write(
              `\r[${'▰'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`,
            );
          }
        },
      });
process.stderr.write('\n');
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

// Shard child: hand the records back to the parent and print nothing.
if (shardOut) {
  writeFileSync(shardOut, JSON.stringify(records));
  process.exit(0);
}

const agg = aggregate(records, config);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const lines = [
  '',
  `RESULTS (${games} games, ${elapsed}s)`,
  `  ${botAName.toUpperCase()} (A) wins: ${agg.winsA}  (${pct(agg.winRateA)}, 95% CI ${pct(agg.ciA.lo)}–${pct(agg.ciA.hi)})`,
  `  ${botBName.toUpperCase()} (B) wins: ${agg.winsB}  draws: ${agg.draws}`,
  `  first-player advantage: ${pct(agg.firstPlayerRate)} of ${agg.decidedGames} decided (CI ${pct(agg.ciFirst.lo)}–${pct(agg.ciFirst.hi)})`,
  `  game length: mean ${agg.meanTurns.toFixed(1)} turns, median ${agg.medianTurns}`,
  '',
  `  per-game usage        shots   pings   moves  decoys  acc(rep)  acc(real)  fake/decoy`,
  ...(['a', 'b'] as const).map((side) => {
    const s = agg[side];
    const name = side === 'a' ? botAName : botBName;
    return `  ${name.padEnd(18)} ${s.shotsPerGame.toFixed(1).padStart(7)} ${s.pingsPerGame.toFixed(1).padStart(7)} ${s.movesPerGame.toFixed(1).padStart(7)} ${s.decoysPerGame.toFixed(2).padStart(7)} ${pct(s.reportedAccuracy).padStart(9)} ${pct(s.realAccuracy).padStart(10)} ${s.fakeHitsPerDecoy.toFixed(2).padStart(11)}`;
  }),
  '',
  agg.flags.length ? `  FLAGS:\n${agg.flags.map((f) => `   ⚠ ${f}`).join('\n')}` : '  no degenerate findings',
  '',
];
console.log(lines.join('\n'));

const jsonPath = args.get('json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ meta: { botA: botAName, botB: botBName, preset: presetName, games, seed, samples }, aggregate: agg, records }, null, 2));
  console.error(`wrote ${jsonPath}`);
}
const csvPath = args.get('csv');
if (csvPath) {
  writeFileSync(csvPath, recordsToCsv(records));
  console.error(`wrote ${csvPath}`);
}
