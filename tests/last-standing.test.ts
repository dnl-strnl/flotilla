import { describe, expect, it } from 'vitest';
import {
  AP_COST,
  AP_CAP,
  AP_FLOOR,
  budgetFor,
  PRESETS,
  aliveSeats,
  createGame,
  isDead,
  lastAfloat,
  legalActions,
  mulberry32,
  remainingForce,
  shipCells,
  step,
  type GameState,
  type PlayerState,
} from '../src/engine';
import { TEST_FLEET } from './helpers';

// TEST_FLEET is 17 cells across 5 hulls: carrier 5, battleship 4, cruiser 3, submarine 3,
// destroyer 2.
const FULL = { squares: 17, ships: 5 };

function melee(seed = 7): GameState {
  return createGame(
    PRESETS.FLOTILLA,
    [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    seed,
  );
}

// Mark `segments` cells of one hull as hit, sinking it if that finishes it. The win
// condition reads ship state directly, so hand-damage is a legitimate fixture here —
// unlike anything a bot must react to, which has to be inflicted with real shells.
function hurt(player: PlayerState, shipIdx: number, segments: number): void {
  const ship = player.ships[shipIdx]!;
  for (let i = 0; i < segments; i++) ship.hits[i] = true;
  ship.sunk = ship.hits.every(Boolean);
}

// Walk the game forward with one seat shelling one board cell by cell and everyone else
// passing, until `cells` runs out or the game ends.
function grind(start: GameState, shooter: number, at: number, cells: number[]): GameState {
  const rng = mulberry32(99);
  let s = start;
  let guard = 0;
  const left = [...cells];
  while (s.phase.kind === 'playing' && left.length > 0 && guard++ < 600) {
    if (s.activePlayer === shooter && s.ap >= AP_COST.FIRE) {
      s = step(s, { type: 'FIRE', cell: left.shift()!, at }, rng).state;
    } else {
      s = step(s, { type: 'PASS' }, rng).state;
    }
  }
  return s;
}

describe('remainingForce', () => {
  it('counts unhit cells and hulls still afloat', () => {
    const p = melee().players[0]!;
    expect(remainingForce(p)).toEqual(FULL);
    hurt(p, 0, 2);
    expect(remainingForce(p)).toEqual({ squares: 15, ships: 5 });
    hurt(p, 4, 2);
    expect(remainingForce(p)).toEqual({ squares: 13, ships: 4 });
  });

  it('a sunk hull contributes no squares', () => {
    const p = melee().players[0]!;
    for (let i = 0; i < 5; i++) hurt(p, i, 5);
    expect(remainingForce(p)).toEqual({ squares: 0, ships: 0 });
  });
});

describe('lastAfloat', () => {
  it('names nobody while more than one fleet is up', () => {
    const players = melee().players;
    expect(lastAfloat(players)).toBeNull();
    for (let i = 0; i < 5; i++) hurt(players[1]!, i, 5);
    expect(aliveSeats(players)).toEqual([0, 2]);
    expect(lastAfloat(players)).toBeNull();
  });

  it('names the one fleet left', () => {
    const players = melee().players;
    for (let i = 0; i < 5; i++) hurt(players[1]!, i, 5);
    for (let i = 0; i < 5; i++) hurt(players[2]!, i, 5);
    expect(players.map(isDead)).toEqual([false, true, true]);
    expect(lastAfloat(players)).toBe(0);
  });

  it('is indifferent to how battered the survivor is — a duel always ends this way', () => {
    // Whatever shape the shooter is in, it holds a hull and the defender does not.
    for (const damage of [0, 1, 4, 9, 12, 16]) {
      const players = createGame(
        PRESETS.FLOTILLA,
        [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
        1,
      ).players;
      let left = damage;
      for (let i = 0; i < 5 && left > 0; i++) {
        const take = Math.min(left, players[0]!.ships[i]!.length);
        hurt(players[0]!, i, take);
        left -= take;
      }
      for (let i = 0; i < 5; i++) hurt(players[1]!, i, 5);
      expect(lastAfloat(players)).toBe(0);
    }
  });
});

describe('MELEE plays on past the first kill', () => {
  it('does not end when a fleet dies with a third still afloat', () => {
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    const s = grind(start, killer, 1, start.players[victim]!.ships.flatMap(shipCells));

    expect(s.players[victim]!.ships.every((sh) => sh.sunk)).toBe(true);
    expect(s.phase.kind).toBe('playing');
    expect(aliveSeats(s.players)).toEqual([killer, (killer + 2) % 3].sort());
  });

  it('a crippled killer is no longer punished for firing the shell', () => {
    // The killer is simply down to a duel it has to go on and win.
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    hurt(start.players[killer]!, 0, 5);
    hurt(start.players[killer]!, 1, 4);

    const s = grind(start, killer, 1, start.players[victim]!.ships.flatMap(shipCells));
    expect(isDead(s.players[victim]!)).toBe(true);
    expect(s.phase.kind).toBe('playing');
  });

  it('ends on the second elimination, with the last fleet afloat as winner', () => {
    const start = melee();
    const killer = start.activePlayer;
    const first = (killer + 1) % 3;
    const second = (killer + 2) % 3;

    let s = grind(start, killer, 1, start.players[first]!.ships.flatMap(shipCells));
    expect(s.phase.kind).toBe('playing');
    // Offset 2 still means the same board it meant on turn 1: a dead fleet keeps its seat
    // rather than renumbering the one behind it.
    s = grind(s, killer, 2, start.players[second]!.ships.flatMap(shipCells));

    expect(s.phase).toEqual({ kind: 'won', winner: killer, eliminated: second });
  });

  it('announces each elimination as it happens, naming who fired', () => {
    const rng = mulberry32(5);
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    const hull = start.players[victim]!.ships.flatMap(shipCells);
    let s = start;
    const announced: { player: number; by: number }[] = [];
    let guard = 0;
    while (s.phase.kind === 'playing' && hull.length > 0 && guard++ < 600) {
      const action =
        s.activePlayer === killer && s.ap >= AP_COST.FIRE
          ? ({ type: 'FIRE', cell: hull.shift()!, at: 1 } as const)
          : ({ type: 'PASS' } as const);
      const r = step(s, action, rng);
      s = r.state;
      for (const e of r.events) {
        if (e.type === 'fleetEliminated') announced.push({ player: e.player, by: e.by });
      }
    }
    expect(announced).toEqual([{ player: victim, by: killer }]);
  });

  it('keeps a duel silent about eliminations — the kill IS the ending there', () => {
    const rng = mulberry32(5);
    let s = createGame(
      PRESETS.FLOTILLA,
      [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
      3,
    );
    const victim = (s.activePlayer + 1) % 2;
    const hull = s.players[victim]!.ships.flatMap(shipCells);
    const seen: string[] = [];
    let guard = 0;
    while (s.phase.kind === 'playing' && hull.length > 0 && guard++ < 600) {
      const action =
        s.ap >= AP_COST.FIRE && s.activePlayer !== victim
          ? ({ type: 'FIRE', cell: hull.shift()!, at: 1 } as const)
          : ({ type: 'PASS' } as const);
      const r = step(s, action, rng);
      s = r.state;
      seen.push(...r.events.map((e) => e.type));
    }
    expect(seen).not.toContain('fleetEliminated');
    expect(s.phase).toEqual({ kind: 'won', winner: (victim + 1) % 2, eliminated: victim });
  });
});

describe('a destroyed fleet leaves the game running around it', () => {
  it('forfeits its turn slot instead of closing up the rotation', () => {
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    const s = grind(start, killer, 1, start.players[victim]!.ships.flatMap(shipCells));

    // Walk a few more handoffs and collect who actually acts.
    const rng = mulberry32(2);
    let cur = s;
    const seats: number[] = [];
    const turns: number[] = [];
    while (seats.length < 4 && cur.phase.kind === 'playing') {
      seats.push(cur.activePlayer);
      turns.push(cur.turn);
      cur = step(cur, { type: 'PASS' }, rng).state;
    }
    expect(seats).not.toContain(victim);
    // The dead seat's slot is burned, not reclaimed: a survivor's turns stay exactly three
    // apart, which is what the melee adapter's virtual two-player clock is built on.
    expect(turns[2]! - turns[0]!).toBe(3);
    expect(turns[3]! - turns[1]!).toBe(3);
  });

  it('drops out of every targeting plane, and the survivor keeps its own offset', () => {
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    let s = grind(start, killer, 1, start.players[victim]!.ships.flatMap(shipCells));
    while (s.activePlayer !== killer) s = step(s, { type: 'PASS' }, mulberry32(1)).state;

    const aimed = legalActions(s).filter((a) => a.type === 'FIRE' || a.type === 'PING');
    expect(aimed.length).toBeGreaterThan(0);
    // Everything aimed now points at offset 2 — the bystander — and nothing at the wreck.
    expect(new Set(aimed.map((a) => a.at))).toEqual(new Set([2]));
  });

  it('hands both survivors full AP once it is down to a duel', () => {
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    // Three seats up: everyone plays at AP_CAP under meleeFullAp.
    expect(start.budget).toBe(AP_CAP);

    let s = grind(start, killer, 1, start.players[victim]!.ships.flatMap(shipCells));
    // Grind the survivor down to a single hull so the floor is what sets the budget.
    const bystander = (killer + 2) % 3;
    const hull = s.players[bystander]!.ships.flatMap(shipCells);
    s = grind(s, killer, 2, hull.slice(0, 15));
    expect(s.phase.kind).toBe('playing');
    expect(s.players[bystander]!.ships.filter((sh) => !sh.sunk).length).toBe(1);

    while (s.activePlayer !== bystander) s = step(s, { type: 'PASS' }, mulberry32(1)).state;
    // Two fleets left: under finalDuelFullAp even a one-ship fleet plays at AP_CAP. With
    // the rule off it slides onto the duel floor instead.
    expect(s.budget).toBe(AP_CAP);
    expect(budgetFor({ ...s.config, finalDuelFullAp: false }, s.players[bystander]!, 2, 3)).toBe(AP_FLOOR);
  });

  it('keeps the tools that name one board and retires the ones that need a table', () => {
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    const bystander = (killer + 2) % 3;
    // Arm the bystander's locker before anyone dies, by sinking its cheapest hull: the
    // 2-cell destroyer. Four ships still afloat, so the AP budget stays wide enough to
    // afford every tool and the only thing that can take one away later is the seat count.
    hurt(start.players[bystander]!, 4, 2);
    let s = start;
    while (s.activePlayer !== bystander) s = step(s, { type: 'PASS' }, mulberry32(1)).state;
    const armed = new Set(legalActions(s).map((a) => a.type));
    expect(armed.has('SCAN')).toBe(true);
    expect(armed.has('SPRAY')).toBe(true);
    expect(armed.has('ECHO')).toBe(true);
    expect(armed.has('FORK')).toBe(true);

    s = grind(s, killer, 1, start.players[victim]!.ships.flatMap(shipCells));
    while (s.activePlayer !== bystander) s = step(s, { type: 'PASS' }, mulberry32(1)).state;

    const left = new Set(legalActions(s).map((a) => a.type));
    // SCAN and SPRAY name one board, so they still mean what they meant.
    expect(left.has('SCAN')).toBe(true);
    expect(left.has('SPRAY')).toBe(true);
    // FORK and ECHO need two live rivals.
    expect(left.has('ECHO')).toBe(false);
    expect(left.has('FORK')).toBe(false);
  });
});

describe('volleys stop at the water line', () => {
  it('a SPRAY that empties a fleet does not keep shelling the wreck', () => {
    const rng = mulberry32(8);
    const start = melee();
    const killer = start.activePlayer;
    const victim = (killer + 1) % 3;
    // Leave the victim a single destroyer sitting inside one 2x2 block, and hurt the
    // killer enough to unlock SPRAY.
    for (const i of [0, 1, 2, 3]) hurt(start.players[victim]!, i, 5);
    hurt(start.players[killer]!, 0, 5);
    hurt(start.players[killer]!, 1, 4);
    hurt(start.players[killer]!, 2, 3);

    let s = start;
    while (s.activePlayer !== killer) s = step(s, { type: 'PASS' }, rng).state;
    const destroyer = shipCells(s.players[victim]!.ships[4]!);
    // The destroyer is at 80-81; the 2x2 anchored at 80 covers 80, 81, 90, 91.
    expect(destroyer).toEqual([80, 81]);

    const r = step(s, { type: 'SPRAY', cell: 80, at: 1 }, rng);
    expect(isDead(r.state.players[victim]!)).toBe(true);
    expect(r.state.phase.kind).toBe('playing');
    // Two shells sank it; the block's remaining cells were never fired.
    const landed = r.events.filter((e) => e.type === 'fire').map((e) => e.cell);
    expect(landed).toEqual([80, 81]);
  });
});
