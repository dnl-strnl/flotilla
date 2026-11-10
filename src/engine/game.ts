import { AP_CAP, AP_COST, AP_FLOOR } from './types';
import type {
  AtLeastTwo,
  Force,
  GameConfig,
  GameState,
  PlayerId,
  PlayerState,
  Ship,
  ShipPlacement,
} from './types';
import { placementToShip, validateFleet } from './placement';
import { activePlayerFor } from './order';

// AP at turn start: clamp(unsunk ships, AP_FLOOR..AP_CAP); salvoBudget off = one shot's
// worth. Three fleets afloat play at AP_CAP under meleeFullAp; `seats` (fleets dealt) tells
// a MELEE final duel (AP_CAP under finalDuelFullAp) apart from a two-player game.
export function budgetFor(
  config: GameConfig,
  player: PlayerState,
  aliveCount: number,
  seats: number = aliveCount,
): number {
  if (!config.salvoBudget) return AP_COST.FIRE;
  if (config.meleeFullAp && aliveCount > 2) return AP_CAP;
  if (config.finalDuelFullAp && seats > 2 && aliveCount === 2) return AP_CAP;
  const unsunk = player.ships.filter((s) => !s.sunk).length;
  return Math.max(AP_FLOOR, Math.min(unsunk, AP_CAP));
}

// Hull cells destroyed in one fleet, wrecks included. Drives the UNDERDOG status.
export function hullDown(player: PlayerState): number {
  return player.ships.reduce((n, s) => n + s.hits.filter(Boolean).length, 0);
}

// Surviving force for one fleet: unhit hull cells, and hulls still afloat. Cells on a sunk
// ship are all hit by definition, so `squares` counts only what is still floating and
// whole.
export function remainingForce(player: Pick<PlayerState, 'ships'>): Force {
  let squares = 0;
  let ships = 0;
  for (const ship of player.ships) {
    squares += ship.hits.filter((h) => !h).length;
    if (!ship.sunk) ships += 1;
  }
  return { squares, ships };
}

// Whether this fleet's special kit has armed: it has lost a whole SHIP.
export function toolsUnlocked(ships: readonly Ship[]): boolean {
  return ships.some((s) => s.sunk);
}

// A fleet with nothing left afloat. Derived from the ships; no death flag is stored.
export function isDead(player: Pick<PlayerState, 'ships'>): boolean {
  return player.ships.every((s) => s.sunk);
}

// Seats still holding a hull. The single source of truth for who acts, who may be fired
// at, and what the AP floor is priced for.
export function aliveSeats(players: readonly PlayerState[]): PlayerId[] {
  return players.flatMap((p, seat) => (isDead(p) ? [] : [seat as PlayerId]));
}

// The winner is the last fleet afloat; MELEE plays on after the first kill. Null while
// more than one fleet is still up.
export function lastAfloat(players: readonly PlayerState[]): PlayerId | null {
  const alive = aliveSeats(players);
  return alive.length === 1 ? alive[0]! : null;
}

function freshPlayer(placements: ShipPlacement[]): PlayerState {
  return {
    ships: placements.map(placementToShip),
    decoys: [],
    decoysPlaced: 0,
    toolLastUsed: {},
    pings: [],
    wakes: [],
    wakeTrail: [],
    shotsReceived: [],
  };
}

// `firstPlayer` heads the round-robin at every seat count (see order.ts).
export function createGame(
  config: GameConfig,
  placements: AtLeastTwo<ShipPlacement[]>,
  seed: number,
  firstPlayer: PlayerId = 0,
): GameState {
  if (placements.length < 2) {
    throw new Error(`a game needs at least 2 fleets, got ${placements.length}`);
  }
  placements.forEach((fleet, side) => {
    const errors = validateFleet(fleet);
    if (errors.length > 0) {
      throw new Error(`invalid fleet for player ${side}: ${JSON.stringify(errors)}`);
    }
  });
  // The length check above is what makes this cast true at runtime.
  const players = placements.map(freshPlayer) as AtLeastTwo<PlayerState>;
  const opener = activePlayerFor(1, players.length, firstPlayer);
  return {
    config: { ...config },
    seed,
    firstPlayer,
    turn: 1,
    activePlayer: opener,
    ap: budgetFor(config, players[opener]!, players.length),
    budget: budgetFor(config, players[opener]!, players.length),
    movedShips: [],
    pingsThisTurn: 0,
    players,
    shots: [],
    phase: { kind: 'playing' },
  };
}
