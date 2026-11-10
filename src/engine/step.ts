import {
  AP_COST,
  SCAN_SIZE,
  ECHO_SIZE,
  WAKE_SNIFF_TURNS,
  maxTurnsFor,
  pingCostFor,
  toolCost,
} from './types';
import type {
  Action,
  Cell,
  Event,
  GameState,
  PlayerId,
  PlayerState,
  RNG,
  ShotLogEntry,
  StepResult,
  WakeRecord,
} from './types';
import { blockCells, pingCells, sprayCells, shipCells } from './board';
import { aliveSeats, budgetFor, isDead } from './game';
import { encodeAction } from './encoding';
import { legalActionIds, isLegal, movedOrigin } from './legality';
import { nextLiveTurn } from './order';

function clone(state: GameState): GameState {
  return structuredClone(state);
}

// End the active player's turn: hand off, advance the turn counter, grant the next budget.
function endTurn(state: GameState, reason: 'pass' | 'exhausted', events: Event[]): void {
  events.push({ type: 'turnEnded', turn: state.turn, player: state.activePlayer, reason });
  // Destroyed fleets forfeit their slots, so the turn counter can jump by more than one.
  const alive = state.players.map((p) => !isDead(p));
  const next = nextLiveTurn(
    state.turn,
    alive,
    state.firstPlayer,
    maxTurnsFor(state.players.length),
  );
  if (!next) {
    state.phase = { kind: 'draw' };
    events.push({ type: 'gameOver', turn: state.turn, result: 'draw' });
    return;
  }
  const aliveCount = alive.filter(Boolean).length;
  state.turn = next.turn;
  state.activePlayer = next.seat;
  state.budget = budgetFor(state.config, state.players[next.seat]!, aliveCount, state.players.length);
  state.ap = state.budget;
  state.movedShips = [];
  state.pingsThisTurn = 0;
  events.push({ type: 'turnStarted', turn: state.turn, player: next.seat, budget: state.budget });
}

// True if the active player has any affordable non-PASS action left.
function hasNonPassAction(state: GameState): boolean {
  return legalActionIds(state).some((id) => id !== encodeAction({ type: 'PASS' }));
}

// Out-of-band concession: `player` strikes their colors and the opponent wins. Deliberately
// NOT an Action — it never enters the encoded action space, so bots can't pick it; replays
// carry it as Replay.forfeit instead of an actions[] entry.
export function forfeit(prev: GameState, player: PlayerId): StepResult {
  if (prev.phase.kind !== 'playing') {
    throw new Error('forfeit() called on a finished game');
  }
  // "The other player" only names someone at N=2; MELEE has no concede path.
  if (prev.players.length !== 2) {
    throw new Error('forfeit() is unsupported with three or more fleets');
  }
  const state = clone(prev);
  const winner: PlayerId = player === 0 ? 1 : 0;
  state.phase = { kind: 'won', winner, byForfeit: true };
  return {
    state,
    events: [{ type: 'gameOver', turn: state.turn, result: 'win', winner, forfeit: player }],
  };
}

// Which of `cells` hold un-hit ship segments, so a sweep never re-trips on known wreckage.
// Shared by PING, SCAN and ECHO; decoys answer through decoyAnswers.
function sonarCells(defender: PlayerState, cells: Cell[]): Cell[] {
  const scanned = new Set(cells);
  const out: Cell[] = [];
  for (const ship of defender.ships) {
    shipCells(ship).forEach((c, seg) => {
      if (!scanned.has(c)) return;
      if (ship.hits[seg]) return;
      out.push(c);
    });
  }
  return out;
}

// Live decoy cells among `cells`: a decoy answers every sweep exactly like a ship segment,
// so no tool can unmask one.
function decoyCells(defender: PlayerState, cells: Cell[]): Cell[] {
  const scanned = new Set(cells);
  return defender.decoys.filter((d) => !d.spent && scanned.has(d.cell)).map((d) => d.cell);
}

function decoyAnswers(defender: PlayerState, cells: Cell[]): boolean {
  return decoyCells(defender, cells).length > 0;
}

// What one shell did, for a caller that may need to cut a volley short:
//   'over' — the game is decided; fire nothing else and return immediately.
//   'dead' — this board is out, but others are still in it; stop firing into THIS one.
//   null   — carry on.
type Impact = 'over' | 'dead' | null;

// One shell landing on one board: damage, decoys, sinking, and the elimination check.
// Shared by FIRE, SPRAY and FORK.
function resolveShell(
  state: GameState,
  me: PlayerId,
  them: PlayerId,
  cell: Cell,
  events: Event[],
  spray: boolean,
): Impact {
  const defender = state.players[them]!;
  // See the note in step(): recorded only when there is more than one enemy to confuse.
  const multi = state.players.length > 2;
  const mark = spray ? ({ spray: true } as const) : {};
  defender.shotsReceived.push({ cell, turn: state.turn, ...(multi ? { by: me } : {}) });

  const hitShip = defender.ships.find((s) => shipCells(s).includes(cell));
  if (hitShip) {
    const segment = shipCells(hitShip).indexOf(cell);
    hitShip.hits[segment] = true;
    const justSunk = !hitShip.sunk && hitShip.hits.every(Boolean);
    if (justSunk) hitShip.sunk = true;
    const record: ShotLogEntry = {
      by: me,
      target: them,
      cell,
      result: justSunk ? 'SUNK' : 'HIT',
      turn: state.turn,
      ...(justSunk ? { sunkShip: hitShip.kind } : {}),
    };
    state.shots.push(record);
    events.push({
      type: 'fire',
      turn: state.turn,
      by: me,
      target: them,
      cell,
      reported: record.result,
      hitShip: hitShip.kind,
      ...(justSunk ? { sunkShip: { kind: hitShip.kind, cells: shipCells(hitShip) } } : {}),
      ...mark,
    });
    if (isDead(defender)) {
      // Losing a fleet takes that seat out; the game ends only when one fleet is left.
      if (multi) events.push({ type: 'fleetEliminated', turn: state.turn, player: them, by: me });
      const afloat = aliveSeats(state.players);
      if (afloat.length > 1) return 'dead';
      const winner = afloat[0]!;
      state.phase = { kind: 'won', winner, eliminated: them };
      events.push({ type: 'gameOver', turn: state.turn, result: 'win', winner, eliminated: them });
      return 'over';
    }
    // The special kit arms on this fleet's FIRST ship lost, so this fires once per game.
    if (justSunk && multi && state.config.specialTools && defender.ships.filter((s) => s.sunk).length === 1) {
      events.push({ type: 'toolUnlocked', turn: state.turn, player: them });
    }
    return null;
  }

  const decoy = defender.decoys.find((d) => !d.spent && d.cell === cell);
  if (decoy) {
    // Fake HIT: the attacker is told HIT; the decoy dies silently.
    decoy.spent = true;
    state.shots.push({ by: me, target: them, cell, result: 'HIT', turn: state.turn });
    events.push({ type: 'fire', turn: state.turn, by: me, target: them, cell, reported: 'HIT', decoy: true, ...mark });
    events.push({ type: 'decoySpent', turn: state.turn, player: them, cell });
  } else {
    state.shots.push({ by: me, target: them, cell, result: 'MISS', turn: state.turn });
    events.push({ type: 'fire', turn: state.turn, by: me, target: them, cell, reported: 'MISS', ...mark });
  }
  return null;
}

// The pure engine transition: new state + events, input never mutated. `rng` is signature
// forward-compat only (current rules are deterministic).
export function step(prev: GameState, action: Action, _rng: RNG): StepResult {
  if (prev.phase.kind !== 'playing') {
    throw new Error('step() called on a finished game');
  }
  if (!isLegal(prev, encodeAction(action))) {
    throw new Error(`illegal action: ${JSON.stringify(action)}`);
  }

  const state = clone(prev);
  const events: Event[] = [];
  const me = state.activePlayer;
  // Aimed actions carry a relative offset; for the rest `them` is the next seat, unused.
  const aimed =
    action.type === 'FIRE' ||
    action.type === 'PING' ||
    action.type === 'SPRAY' ||
    action.type === 'SCAN' ||
    action.type === 'ECHO';
  const offset = aimed ? (action.at ?? 1) : 1;
  const them: PlayerId = (me + offset) % state.players.length;
  const attacker = state.players[me]!;
  const defender = state.players[them]!;
  // Seat ids on records only when there is more than one enemy; omitting them at N=2 keeps
  // two-player replays byte-identical.
  const multi = state.players.length > 2;

  switch (action.type) {
    case 'FIRE': {
      state.ap -= AP_COST.FIRE;
      if (resolveShell(state, me, them, action.cell, events, false) === 'over') return { state, events };
      break;
    }

    case 'SPRAY': {
      state.ap -= toolCost('SPRAY');
      attacker.toolLastUsed.SPRAY = state.turn;
      // Four ordinary shells in reading order; stops early if the board is wiped out.
      for (const cell of sprayCells(action.cell)) {
        const impact = resolveShell(state, me, them, cell, events, true);
        if (impact === 'over') return { state, events };
        if (impact === 'dead') break;
      }
      break;
    }

    case 'FORK': {
      state.ap -= toolCost('FORK');
      attacker.toolLastUsed.FORK = state.turn;
      // The same cell into every LIVE enemy board, nearest seat first.
      for (let offset = 1; offset < state.players.length; offset++) {
        const seat = (me + offset) % state.players.length;
        if (isDead(state.players[seat]!)) continue;
        if (resolveShell(state, me, seat, action.cell, events, true) === 'over') return { state, events };
      }
      break;
    }

    case 'SCAN': {
      state.ap -= toolCost('SCAN');
      attacker.toolLastUsed.SCAN = state.turn;
      const cells = blockCells(action.cell, SCAN_SIZE);
      const answering = new Set([...sonarCells(defender, cells), ...decoyCells(defender, cells)]);
      const live = cells.filter((c) => answering.has(c));
      // Filed as one single-cell sonar record per cell, so every reader sees exactly which
      // cells answered (always with `target`: tools are MELEE only).
      for (const c of cells) {
        attacker.pings.push({ center: c, cells: [c], contact: answering.has(c), turn: state.turn, target: them });
      }
      events.push({
        type: 'scan', turn: state.turn, by: me, target: them, cell: action.cell, cells,
        contact: live.length > 0, live,
      });
      break;
    }

    case 'ECHO': {
      state.ap -= toolCost('ECHO');
      attacker.toolLastUsed.ECHO = state.turn;
      const cells = blockCells(action.cell, ECHO_SIZE);
      const occupancy = sonarCells(defender, cells).length + decoyCells(defender, cells).length;
      const contact = occupancy > 0;
      // Public: every seat but the one lit files the same OCCUPANCY record as the caster.
      state.players.forEach((seat, id) => {
        if (id === them) return;
        seat.pings.push({ center: action.cell, cells: [...cells], contact, occupancy, turn: state.turn, target: them });
      });
      events.push({ type: 'echo', turn: state.turn, by: me, target: them, cells, contact, occupancy });
      break;
    }

    case 'PING': {
      // Priced before the tally moves: this sweep pays the rate it was quoted at.
      state.ap -= pingCostFor(state.config, state.players.length, state.pingsThisTurn);
      state.pingsThisTurn += 1;
      const cells = pingCells(action.center);
      const scanned = new Set(cells);
      const shipPresent = sonarCells(defender, cells).length > 0;
      const contact = decoyAnswers(defender, cells) || shipPresent;
      // Also dredge fresh wake cells inside the scan (WAKE_SNIFF_TURNS);
      // never affects `contact`, and re-sweeping reveals only cells not already known.
      let wakes: WakeRecord[] | undefined;
      for (const w of defender.wakeTrail) {
        // Measured in rounds, not raw turns, so every rival gets its next turn at the wake.
        if (state.turn - w.turn > WAKE_SNIFF_TURNS * state.players.length) continue;
        const known = new Set(
          attacker.wakes
            .filter((r) => r.turn === w.turn && (r.of ?? them) === them)
            .flatMap((r) => r.cells),
        );
        const dredged = w.cells.filter((c) => scanned.has(c) && !known.has(c));
        if (dredged.length === 0) continue;
        (wakes ??= []).push({ cells: dredged, turn: w.turn, ...(multi ? { of: them } : {}) });
        attacker.wakes.push({ cells: [...dredged], turn: w.turn, ...(multi ? { of: them } : {}) });
      }
      attacker.pings.push({
        center: action.center,
        cells,
        contact,
        turn: state.turn,
        ...(multi ? { target: them } : {}),
      });
      events.push({ type: 'ping', turn: state.turn, by: me, target: them, center: action.center, cells, contact, ...(wakes ? { wakes } : {}) });
      break;
    }

    case 'MOVE': {
      state.ap -= AP_COST.MOVE;
      const ship = attacker.ships[action.ship];
      if (!ship) throw new Error(`no ship at index ${action.ship}`);
      const from = ship.origin;
      const oldCells = shipCells(ship);
      const dest = movedOrigin(ship, action.dir);
      if (dest === null) throw new Error(`illegal move destination for ship ${action.ship}`);
      ship.origin = dest; // orientation is unchanged: the ship translates
      state.movedShips.push(action.ship);
      // The vacated cells (old footprint minus new) linger as a silent trail; an enemy
      // sweep on their very next turn may dredge it (see the PING case).
      const newCells = new Set(shipCells(ship));
      attacker.wakeTrail.push({ cells: oldCells.filter((c) => !newCells.has(c)), turn: state.turn });
      events.push({
        type: 'move',
        turn: state.turn,
        player: me,
        ship: action.ship,
        dir: action.dir,
        from,
        to: ship.origin,
      });
      break;
    }

    case 'DECOY': {
      state.ap -= AP_COST.DECOY;
      attacker.decoys.push({ cell: action.cell, spent: false });
      attacker.decoysPlaced += 1;
      events.push({ type: 'decoyPlaced', turn: state.turn, player: me, cell: action.cell });
      break;
    }

    case 'PASS': {
      // An explicit PASS with nothing else affordable is still "exhausted", so logs and
      // stats never depend on who ended the turn.
      const forced = !hasNonPassAction(state);
      events.push({ type: 'passed', turn: state.turn, player: me });
      endTurn(state, forced ? 'exhausted' : 'pass', events);
      return { state, events };
    }
  }

  // The turn ends itself once only PASS is affordable.
  if (!hasNonPassAction(state)) {
    endTurn(state, 'exhausted', events);
  }

  return { state, events };
}
