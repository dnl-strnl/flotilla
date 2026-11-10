import { describe, expect, it } from 'vitest';
import {
  AP_COST,
  PRESETS,
  createGame,
  legalActionIds,
  mulberry32,
  observe,
  step,
  type Action,
  type GameState,
} from '../src/engine';
import { makeMelee } from '../src/ai/melee';
import type { BotName } from '../src/ai';
import { TEST_FLEET } from './helpers';

// TEST_FLEET: carrier 0–4, battleship 20–23, cruiser 40–42, submarine 60–62, destroyer
// 80–81.
const CARRIER = [0, 1, 2, 3, 4];
const BATTLESHIP = [20, 21, 22, 23];
const CRUISER = [40, 41, 42];
const SUBMARINE = [60, 61, 62];
const DESTROYER = [80, 81];

function melee(seed = 11): GameState {
  return createGame(
    PRESETS.FLOTILLA,
    [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    seed,
  );
}

// Land a scripted list of shells, passing turns until each shooter is up with AP to spend.
// Damage has to be inflicted for real: target rules read the public shot log, so a hand-set
// ship.hits is invisible to them.
function bombard(start: GameState, shots: { by: number; at: number; cell: number }[]): GameState {
  const rng = mulberry32(3);
  let s = start;
  let guard = 0;
  for (const shot of shots) {
    while (s.activePlayer !== shot.by || s.ap < AP_COST.FIRE) {
      if (guard++ > 3000) throw new Error('bombard stalled');
      s = step(s, { type: 'PASS' }, rng).state;
    }
    const at = (shot.at - shot.by + 3) % 3;
    s = step(s, { type: 'FIRE', cell: shot.cell, at }, rng).state;
  }
  return s;
}

const salvo = (by: number, at: number, cells: number[]) => cells.map((cell) => ({ by, at, cell }));

// Hand the turn to `seat`.
function handTo(s: GameState, seat: number): GameState {
  const rng = mulberry32(4);
  let cur = s;
  let guard = 0;
  while (cur.activePlayer !== seat) {
    if (guard++ > 100) throw new Error('never reached seat');
    cur = step(cur, { type: 'PASS' }, rng).state;
  }
  return cur;
}

// Every board a bot aims at over `tries` invocations. ECHO and FORK are excluded by
// design: ECHO deliberately lights up the fleet the bot is NOT hunting, and FORK names no
// board at all. Everything else here is pointed at the chosen target, shell or sweep.
function aimedTargets(s: GameState, rank: BotName, tries = 12): number[] {
  const obs = observe(s, s.activePlayer);
  const legal = legalActionIds(s);
  const out: number[] = [];
  for (let i = 0; i < tries; i++) {
    const bot = makeMelee(rank, { samples: 25 });
    const action = bot(obs, legal, mulberry32(100 + i)) as Action;
    if (
      action.type === 'FIRE' ||
      action.type === 'SPRAY' ||
      action.type === 'PING' ||
      action.type === 'SCAN'
    ) {
      out.push((obs.me + (action.at ?? 1)) % 3);
    }
  }
  return out;
}

describe('bots play the last-fleet-standing win condition', () => {
  it('takes a kill in reach even when it is behind on tonnage', () => {
    let s = melee();
    // Seat 2 grinds seat 1 down to its last hull: four ships gone, destroyer left.
    s = bombard(s, [
      ...salvo(2, 1, CARRIER),
      ...salvo(2, 1, BATTLESHIP),
      ...salvo(2, 1, CRUISER),
      ...salvo(2, 1, SUBMARINE),
    ]);
    // And seat 0 — the bot — loses its carrier, so seat 2 is ahead of it on tonnage.
    s = bombard(s, salvo(1, 0, CARRIER));
    s = handTo(s, 0);

    const obs = observe(s, 0);
    expect(obs.intel[1]!.shipsRemaining).toBe(1);
    expect(obs.intel[2]!.shipsRemaining).toBe(5);

    // The kill only buys a duel, so COMMANDER gets the weakest target it wants.
    const targets = aimedTargets(s, 'commander');
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set([1]));
  });

  it("takes the kill over the rank's target preference", () => {
    let s = melee();
    // Seat 2 does all the damage — first grinding seat 1 to its last hull...
    s = bombard(s, [
      ...salvo(2, 1, CARRIER),
      ...salvo(2, 1, BATTLESHIP),
      ...salvo(2, 1, CRUISER),
      ...salvo(2, 1, SUBMARINE),
    ]);
    // ...then taking losses of its own, leaving the bot at seat 0 untouched and ahead.
    s = bombard(s, [...salvo(1, 2, CARRIER), ...salvo(1, 2, BATTLESHIP)]);
    s = handTo(s, 0);

    const obs = observe(s, 0);
    expect(obs.intel[1]!.shipsRemaining).toBe(1);
    expect(obs.intel[2]!.shipsRemaining).toBe(3);

    // COMMODORE bashes the leader, and seat 2 has dealt every shell in the game — but a
    // fleet one hull from gone is a gun it can take off the water this turn, so it does.
    const targets = aimedTargets(s, 'commodore');
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set([1]));
  });

  it('leaves the target rule alone while nobody is within reach of dead', () => {
    let s = melee();
    // Real damage on both boards, but three hulls still afloat on each — nothing is
    // within reach of dead, so there is no kill to promote.
    s = bombard(s, [...salvo(2, 1, CARRIER), ...salvo(2, 1, CRUISER), ...salvo(1, 2, SUBMARINE)]);
    s = handTo(s, 0);

    const obs = observe(s, 0);
    expect(obs.intel[1]!.shipsRemaining).toBe(3);
    expect(obs.intel[2]!.shipsRemaining).toBe(4);

    // COMMANDER wants whoever is closest to dead; with nothing to finish, it simply gets
    // it.
    expect(new Set(aimedTargets(s, 'commander'))).toEqual(new Set([1]));
  });

  it('never aims at a fleet that is already gone', () => {
    let s = melee();
    // Seat 2 wipes seat 1 out entirely. The game plays on; seat 0 is up next.
    s = bombard(s, [
      ...salvo(2, 1, CARRIER),
      ...salvo(2, 1, BATTLESHIP),
      ...salvo(2, 1, CRUISER),
      ...salvo(2, 1, SUBMARINE),
      ...salvo(2, 1, DESTROYER),
    ]);
    expect(s.phase.kind).toBe('playing');
    expect(s.players[1]!.ships.every((sh) => sh.sunk)).toBe(true);
    s = handTo(s, 0);

    // COMMANDER's own scoring would love the wreck — it is as close to dead as a fleet
    // gets.
    for (const rank of ['commander', 'captain', 'commodore', 'lieutenant'] as const) {
      expect(new Set(aimedTargets(s, rank))).toEqual(new Set([2]));
    }
  });
});
