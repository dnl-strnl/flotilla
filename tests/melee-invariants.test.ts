import { describe, expect, it } from 'vitest';
import {
  AP_CAP,
  AP_FLOOR,
  FLEET,
  isDead,
  MAX_DECOYS,
  PRESETS,
  toolsUnlocked,
  toolCooldownLeft,
  createGame,
  exportReplay,
  legalActionIds,
  maxTurnsFor,
  mulberry32,
  observe,
  randomFleet,
  redactEventsFor,
  runReplay,
  sprayCells,
  shipCells,
  step,
  type AtLeastTwo,
  type Event,
  type GameState,
  type ShipPlacement,
} from '../src/engine';
import { makeMelee } from '../src/ai';

// Rule integrity under play, not in isolation: drive whole three-way games with real bots
// and assert the invariants hold at every single ply. A rule that only breaks in the
// hundredth turn of a real game is exactly what a hand-written scenario test misses.

interface Violation {
  game: number;
  turn: number;
  what: string;
}

function auditGame(seed: number, game: number, violations: Violation[]): void {
  const rng = mulberry32(seed);
  const bots = [
    makeMelee('commodore', { samples: 30 }),
    makeMelee('captain', { samples: 30 }),
    makeMelee('commander', { samples: 30 }),
  ];
  const fleets = Array.from({ length: 3 }, () => randomFleet(rng)) as AtLeastTwo<ShipPlacement[]>;
  let state = createGame(PRESETS.FLOTILLA, fleets, seed);

  const bad = (what: string) => violations.push({ game, turn: state.turn, what });
  const seatLog: { seat: number; turn: number }[] = [
    { seat: state.activePlayer, turn: state.turn },
  ];
  const events: Event[] = [];
  const actions = [];

  // Damage snapshot, to prove a shot only ever touches the board it named.
  const hitCount = (s: GameState) =>
    s.players.map((p) => p.ships.reduce((n, sh) => n + sh.hits.filter(Boolean).length, 0));
  // Ships that have taken damage are pinned forever; remember where they sit.
  const pinnedOrigins = new Map<string, number>();

  let guard = 0;
  while (state.phase.kind === 'playing' && guard++ < 4000) {
    const seat = state.activePlayer;
    const legal = legalActionIds(state);
    const before = hitCount(state);
    const beforeShots = state.shots.length;

    for (const [i, p] of state.players.entries()) {
      for (const [j, sh] of p.ships.entries()) {
        if (sh.hits.some(Boolean)) {
          const key = `${i}:${j}`;
          const seen = pinnedOrigins.get(key);
          if (seen !== undefined && seen !== sh.origin) bad(`damaged ship ${key} moved`);
          pinnedOrigins.set(key, sh.origin);
        }
      }
    }

    const action = bots[seat]!(observe(state, seat), legal, rng);
    actions.push(action);
    const r = step(state, action, rng);
    events.push(...r.events);
    const next = r.state;

    // AP never goes negative, and never exceeds the budget it was granted.
    if (next.ap < 0) bad(`negative AP (${next.ap})`);
    if (next.ap > next.budget) bad(`AP ${next.ap} over budget ${next.budget}`);

    // A FIRE damages exactly the board it named, and nothing else. A SPRAY is four of them
    // at once, audited below.
    if (action.type === 'FIRE') {
      const target = (seat + (action.at ?? 1)) % 3;
      const after = hitCount(next);
      next.players.forEach((_, i) => {
        const delta = after[i]! - before[i]!;
        if (i === target ? delta < 0 || delta > 1 : delta !== 0) {
          bad(`shot at ${target} changed board ${i} by ${delta}`);
        }
      });
      if (next.shots.length !== beforeShots + 1) bad('shot did not append exactly one log entry');
      const rec = next.shots[next.shots.length - 1]!;
      if (rec.by !== seat || rec.target !== target) bad('shot log entry misattributed');
    } else if (action.type === 'SPRAY') {
      // Four shells on one board in one 2×2 block, charged to the seat that fired, from a
      // locker that damage had already opened, with SPRAY off cooldown and now cooling.
      const target = (seat + (action.at ?? 1)) % 3;
      if (toolCooldownLeft(state.players[seat]!.toolLastUsed.SPRAY, state.turn, 3) > 0) bad('SPRAY fired while cooling');
      if (next.players[seat]!.toolLastUsed.SPRAY !== state.turn) bad('SPRAY was not stamped this turn');
      if (!toolsUnlocked(state.players[seat]!.ships)) bad('SPRAY fired before a ship was lost');
      const after = hitCount(next);
      const block = new Set(sprayCells(action.cell));
      if (block.size !== 4) bad('spray block is not four distinct cells');
      next.players.forEach((_, i) => {
        const delta = after[i]! - before[i]!;
        if (i === target ? delta < 0 || delta > 4 : delta !== 0) {
          bad(`spray at ${target} changed board ${i} by ${delta}`);
        }
      });
      // Four entries unless the block sank the target's last ship part-way.
      const appended = next.shots.length - beforeShots;
      if (appended < 1 || appended > 4) bad(`spray appended ${appended} log entries`);
      if (appended < 4 && !isDead(next.players[target]!)) bad('spray stopped short of four cells');
      for (const rec of next.shots.slice(beforeShots)) {
        if (rec.by !== seat || rec.target !== target) bad('spray log entry misattributed');
        if (!block.has(rec.cell)) bad('spray hit a cell outside its block');
      }
    } else if (action.type === 'FORK') {
      // One cell into every enemy board at once: one log entry per rival, same cell, all
      // charged to the firing seat — unless a wipe part-way through ended the game.
      const appended = next.shots.slice(beforeShots);
      if (appended.length < 1 || appended.length > 2) bad(`fork appended ${appended.length} entries`);
      if (appended.length < 2 && next.phase.kind === 'playing') bad('fork stopped short');
      for (const rec of appended) {
        if (rec.by !== seat) bad('fork log entry misattributed');
        if (rec.cell !== action.cell) bad('fork hit a cell it did not name');
        if (rec.target === seat) bad('fork hit its own board');
      }
      if (new Set(appended.map((r) => r.target)).size !== appended.length) {
        bad('fork hit one board twice');
      }
      if (toolCooldownLeft(state.players[seat]!.toolLastUsed.FORK, state.turn, 3) > 0) bad('FORK fired while cooling');
      if (next.players[seat]!.toolLastUsed.FORK !== state.turn) bad('FORK was not stamped this turn');
    } else if (next.shots.length !== beforeShots) {
      bad(`${action.type} appended to the shot log`);
    }

    // Decoys are capped and never exceed the cap even across turns.
    next.players.forEach((p, i) => {
      if (p.decoysPlaced > MAX_DECOYS) bad(`player ${i} placed ${p.decoysPlaced} decoys`);
      if (p.decoys.length > MAX_DECOYS) bad(`player ${i} holds ${p.decoys.length} decoys`);
    });

    // No special tool is ever fired by a fleet that has not yet lost a ship — the one gate
    // the whole locker hangs on.
    next.players.forEach((p, i) => {
      for (const id of Object.keys(p.toolLastUsed)) {
        if (!toolsUnlocked(p.ships)) bad(`player ${i} fired ${id} with its fleet still whole`);
      }
    });

    // Sunk ships stay sunk, and a sunk ship is fully hit.
    next.players.forEach((p, i) => {
      p.ships.forEach((sh, j) => {
        if (sh.sunk && !sh.hits.every(Boolean)) bad(`sunk ship ${i}:${j} has un-hit segments`);
        if (!sh.sunk && sh.hits.every(Boolean)) bad(`ship ${i}:${j} fully hit but not sunk`);
      });
    });

    // A new turn: the budget rule, and the seat rotation.
    if (next.turn !== state.turn && next.phase.kind === 'playing') {
      seatLog.push({ seat: next.activePlayer, turn: next.turn });
      const unsunk = next.players[next.activePlayer]!.ships.filter((s) => !s.sunk).length;
      // Budget priced on fleets still afloat, re-derived by hand: AP_CAP under meleeFullAp
      // while three are up, AP_CAP under finalDuelFullAp once two survivors duel.
      const alive = next.players.filter((p) => !p.ships.every((sh) => sh.sunk)).length;
      const want =
        (next.config.meleeFullAp && alive > 2) || (next.config.finalDuelFullAp && alive === 2)
          ? AP_CAP
          : Math.max(AP_FLOOR, Math.min(unsunk, AP_CAP));
      if (next.budget !== want) bad(`budget ${next.budget} should be ${want}`);
      if (next.ap !== next.budget) bad('turn opened with ap !== budget');
      if (next.players[next.activePlayer]!.ships.every((sh) => sh.sunk)) {
        bad(`destroyed seat ${next.activePlayer} was handed a turn`);
      }
    }
    state = next;
  }

  if (state.turn > maxTurnsFor(3)) bad(`turn ${state.turn} past the ${maxTurnsFor(3)} cap`);

  // Rotation: never twice in a row, and each turn's seat is the fixed round-robin's for
  // that turn number (a destroyed fleet forfeits its slot, so survivors keep their
  // cadence).
  for (let i = 1; i < seatLog.length; i++) {
    if (seatLog[i]!.seat === seatLog[i - 1]!.seat) bad(`seat ${seatLog[i]!.seat} acted twice in a row`);
  }
  for (const { seat, turn } of seatLog) {
    // createGame defaults firstPlayer to 0, so the slot for turn t belongs to (t-1) % 3.
    if (seat !== (turn - 1) % 3) bad(`turn ${turn} went to seat ${seat}, not ${(turn - 1) % 3}`);
  }

  // A win means exactly one fleet is still afloat, and it is the winner. At three seats
  // that is two wrecks on the water, not one — the game no longer stops at the first.
  if (state.phase.kind === 'won') {
    const afloat = state.players.filter((p) => !p.ships.every((s) => s.sunk));
    if (afloat.length !== 1) bad(`${afloat.length} fleets afloat at a win`);
    if (state.players[state.phase.winner]!.ships.every((s) => s.sunk)) bad('winner is dead');
  }

  // Redaction: nobody but the defender sees a defender's private truth.
  for (const seat of [0, 1, 2]) {
    for (const e of redactEventsFor(seat, events)) {
      if (e.type !== 'fire' || e.target === seat) continue;
      if (e.hitShip !== undefined) bad(`seat ${seat} saw hitShip on another board`);
      if (e.decoy !== undefined) bad(`seat ${seat} saw a decoy flag on another board`);
      if (e.sunkShip?.cells !== undefined) bad(`seat ${seat} saw sunk cells on another board`);
    }
    // A decoy being spent is never surfaced to anyone but its owner.
    const spent = redactEventsFor(seat, events).filter((e) => e.type === 'decoySpent');
    if (spent.some((e) => e.type === 'decoySpent' && e.player !== seat)) {
      bad(`seat ${seat} saw someone else's decoy expend`);
    }
  }

  // A fleet is never more than its hull, and ships never overlap their own fleet.
  const hull = FLEET.reduce((n, f) => n + f.length, 0);
  state.players.forEach((p, i) => {
    const cells = p.ships.flatMap(shipCells);
    if (cells.length !== hull) bad(`player ${i} hull is ${cells.length}, not ${hull}`);
    if (new Set(cells).size !== cells.length) bad(`player ${i} has overlapping ships`);
    if (cells.some((c) => c < 0 || c > 99)) bad(`player ${i} has a ship off the board`);
  });

  // The whole game replays to the identical final state.
  const replay = exportReplay(PRESETS.FLOTILLA, seed, state.firstPlayer, fleets, actions, events);
  const rerun = runReplay(JSON.parse(JSON.stringify(replay)));
  if (JSON.stringify(rerun.state) !== JSON.stringify(state)) bad('replay diverged from the game');
}

describe('MELEE rule integrity under play', () => {
  it('holds every invariant across whole bot-driven games', () => {
    const violations: Violation[] = [];
    for (let g = 0; g < 12; g++) auditGame(1000 + g, g, violations);
    expect(violations).toEqual([]);
  });
});
