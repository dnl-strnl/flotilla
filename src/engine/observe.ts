import { MAX_DECOYS, TOOLS, pingCostFor, toolCooldownLeft } from './types';
import { hullDown } from './game';
import type {
  Event,
  GameState,
  Observation,
  PlayerId,
  ShotRecord,
  TargetIntel,
  ToolId,
} from './types';

// What one seat knows about one enemy board. Shots are public at both ends: every seat
// sees who fired at whom. Only the defender's private truth (real ship identity on a
// non-sinking hit, and whether a "HIT" was really a decoy) stays behind.
function intelAbout(state: GameState, viewer: PlayerId, target: PlayerId): TargetIntel {
  const me = state.players[viewer]!;
  const shots: ShotRecord[] = state.shots
    .filter((s) => s.target === target)
    .map((s) => ({
      cell: s.cell,
      result: s.result,
      turn: s.turn,
      ...(s.sunkShip ? { sunkShip: s.sunkShip } : {}),
      by: s.by,
    }));
  const nextSeat = (viewer + 1) % state.players.length;
  return {
    shots,
    pings: me.pings.filter((p) => (p.target ?? nextSeat) === target),
    wakes: me.wakes.filter((w) => (w.of ?? nextSeat) === target),
    sunk: state.shots
      .filter((s) => s.target === target && s.result === 'SUNK' && s.sunkShip)
      .map((s) => s.sunkShip!),
    shipsRemaining: state.players[target]!.ships.filter((s) => !s.sunk).length,
  };
}

// A board still in the fight, read off the public intel. Ship counts are public — every
// sinking is announced — so this names nothing a seat could not already count.
export const intelAlive = (intel: TargetIntel): boolean => intel.shipsRemaining > 0;

// The redacted view for one side. Bots receive ONLY this (never GameState) — structurally
// enforces no-cheating. Deep-copied so consumers can't mutate state.
export function observe(state: GameState, player: PlayerId): Observation {
  const me = state.players[player]!;
  const isMyTurn = state.activePlayer === player;
  const n = state.players.length;
  const intel = state.players.map((_, seat) =>
    seat === player ? null : intelAbout(state, player, seat),
  );
  // The flat fields are the two-player view: this same intel about the NEXT seat.
  // `myShots` stays the viewer's OWN fire.
  const next = intel[(player + 1) % n]!;
  return structuredClone({
    config: state.config,
    me: player,
    playerCount: n,
    turn: state.turn,
    ap: isMyTurn ? state.ap : 0,
    budget: isMyTurn ? state.budget : 0,
    pingCost: isMyTurn ? pingCostFor(state.config, n, state.pingsThisTurn) : 0,
    movedShips: isMyTurn ? state.movedShips : [],
    myShips: me.ships,
    myDecoys: me.decoys.map(({ cell, spent }) => ({ cell, spent })),
    myDecoysLeft: MAX_DECOYS - me.decoysPlaced,
    myToolCooldowns: Object.fromEntries(
      TOOLS.map(({ id }) => [id, toolCooldownLeft(me.toolLastUsed[id], state.turn, n)]),
    ) as Record<ToolId, number>,
    myHullDown: hullDown(me),
    shotsAgainstMe: me.shotsReceived,
    myShots: myShotsAt(state, player, (player + 1) % n),
    myPings: next.pings,
    enemyWakes: next.wakes,
    enemySunk: next.sunk,
    enemyShipsRemaining: next.shipsRemaining,
    intel,
  });
}

// The viewer's own fire at one board.
function myShotsAt(state: GameState, viewer: PlayerId, target: PlayerId): ShotRecord[] {
  return state.shots
    .filter((s) => s.by === viewer && s.target === target)
    .map((s) => ({
      cell: s.cell,
      result: s.result,
      turn: s.turn,
      ...(s.sunkShip ? { sunkShip: s.sunkShip } : {}),
    }));
}

// A shot as everyone except its target may see it: who fired, at which board, where it
// landed and what was reported — with the defender's private truth removed.
function publicShot(e: Extract<Event, { type: 'fire' }>): Event {
  return {
    type: 'fire',
    turn: e.turn,
    by: e.by,
    target: e.target,
    cell: e.cell,
    reported: e.reported,
    ...(e.sunkShip ? { sunkShip: { kind: e.sunkShip.kind } } : {}),
    // Public by design (types.ts); dropping it made the shooter's spray four guns at once.
    ...(e.spray ? { spray: true as const } : {}),
  };
}

// Filter events to what one side may know: rival pings/moves/decoys become an opaque
// `enemyActivity` (UI-only, never in Observation); my shots carry only the reported result;
// shots at me are full truth; everyone else's are public.
export function redactEventsFor(player: PlayerId, events: Event[]): Event[] {
  const out: Event[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'turnStarted':
      case 'turnEnded':
      case 'passed':
      case 'gameOver':
      // An elimination is public: the last SUNK already announced it.
      case 'fleetEliminated':
        out.push(e);
        break;
      case 'fire':
        out.push(e.target === player ? structuredClone(e) : publicShot(e));
        break;
      case 'ping':
        if (e.by === player) out.push(structuredClone(e));
        else out.push({ type: 'enemyActivity', turn: e.turn, player: e.by });
        break;
      case 'move':
        if (e.player === player) out.push(structuredClone(e));
        else out.push({ type: 'enemyActivity', turn: e.turn, player: e.player });
        break;
      case 'decoyPlaced':
        if (e.player === player) out.push(structuredClone(e));
        else out.push({ type: 'enemyActivity', turn: e.turn, player: e.player });
        break;
      case 'echo':
        // ECHO is public by design, at every end.
        out.push(structuredClone(e));
        break;
      case 'scan':
        // An ordinary sweep as far as everyone else is concerned.
        if (e.by === player) out.push(structuredClone(e));
        else out.push({ type: 'enemyActivity', turn: e.turn, player: e.by });
        break;
      case 'toolUnlocked':
        // A rival's unlocked kit is private to them.
        if (e.player === player) out.push(e);
        break;
      case 'decoySpent':
        // Consuming a decoy is triggered by the viewer's own shot, not by the owner
        // spending AP — surfacing it would reveal the deception.
        if (e.player === player) out.push(structuredClone(e));
        break;
      case 'enemyActivity':
        break; // never present in engine output
    }
  }
  return out;
}
