import {
  AP_COST,
  CELL_COUNT,
  MAX_DECOYS,
  MOVE_DELTA,
  MOVE_DIRS,
  SCAN_SIZE,
  ECHO_SIZE,
  TOOLS,
  toolCooldownLeft,
  pingCostFor,
} from './types';
import type { Action, Cell, GameState, PlayerState, Ship } from './types';
import { blockFits, cellsFor, fitsOnBoard, inBounds, sprayFits, shipCells, toCell, toRC } from './board';
import { isDead, toolsUnlocked } from './game';
import {
  DECOY_BASE,
  MOVE_BASE,
  PASS_ID,
  actionCount,
  decodeAction,
  encodeAction,
} from './encoding';

// Cells occupied by a player's own assets: all ship cells (wrecks included) + alive decoys.
function ownOccupiedCells(player: PlayerState): Set<number> {
  const occupied = new Set<number>();
  for (const ship of player.ships) for (const cell of shipCells(ship)) occupied.add(cell);
  for (const decoy of player.decoys) if (!decoy.spent) occupied.add(decoy.cell);
  return occupied;
}

// Origin after translating one cell in `dir` (orientation kept), or null if any of the
// resulting footprint would leave the board.
export function movedOrigin(ship: Ship, dir: (typeof MOVE_DIRS)[number]): Cell | null {
  const { dr, dc } = MOVE_DELTA[dir];
  const { r, c } = toRC(ship.origin);
  const nr = r + dr;
  const nc = c + dc;
  // Bounds-check the raw row/col before toCell: toCell(r, 10) silently wraps
  // to column 0 of the next row, which fitsOnBoard would then accept.
  if (!inBounds(nr, nc)) return null;
  if (!fitsOnBoard(toCell(nr, nc), ship.orient, ship.length)) return null;
  return toCell(nr, nc);
}

// The single source of truth for legality, over the canonical 0..324 encoding. step()
// re-validates through this; UI and bots must select only from it.
export function legalActionIds(state: GameState): number[] {
  if (state.phase.kind !== 'playing') return [];
  const { config, ap } = state;
  const me = state.players[state.activePlayer]!;
  const ids: number[] = [];

  // One FIRE/PING plane per LIVE opponent, nearest seat first. Offsets never renumber, so
  // `at` names the same board all game; a destroyed fleet just drops out of targeting.
  const targets: number[] = [];
  for (let at = 1; at < state.players.length; at++) {
    if (!isDead(state.players[(state.activePlayer + at) % state.players.length]!)) targets.push(at);
  }

  if (ap >= AP_COST.FIRE) {
    for (const at of targets) {
      for (let cell = 0; cell < CELL_COUNT; cell++) ids.push(encodeAction({ type: 'FIRE', cell, at }));
    }
  }

  // SPECIAL TOOLS: every availability gate lives here (unlock, cooldown, AP). FORK and ECHO
  // also need two live rivals, so they retire in the final duel; SCAN and SPRAY play on.
  if (config.specialTools && state.players.length > 2 && toolsUnlocked(me.ships)) {
    const threeHanded = targets.length > 1;
    for (const { id, cost } of TOOLS) {
      if (ap < cost) continue;
      if (toolCooldownLeft(me.toolLastUsed[id], state.turn, state.players.length) > 0) continue;
      switch (id) {
        case 'SPRAY':
          for (const at of targets) {
            for (let cell = 0; cell < CELL_COUNT; cell++) {
              if (sprayFits(cell)) ids.push(encodeAction({ type: 'SPRAY', cell, at }));
            }
          }
          break;
        case 'SCAN':
          for (const at of targets) {
            for (let cell = 0; cell < CELL_COUNT; cell++) {
              if (blockFits(cell, SCAN_SIZE)) ids.push(encodeAction({ type: 'SCAN', cell, at }));
            }
          }
          break;
        case 'ECHO':
          if (!threeHanded) break;
          for (const at of targets) {
            for (let cell = 0; cell < CELL_COUNT; cell++) {
              if (blockFits(cell, ECHO_SIZE)) {
                ids.push(encodeAction({ type: 'ECHO', cell, at }));
              }
            }
          }
          break;
        case 'FORK':
          // Names no target: one cell into every live enemy board at once.
          if (!threeHanded) break;
          for (let cell = 0; cell < CELL_COUNT; cell++) {
            ids.push(encodeAction({ type: 'FORK', cell }));
          }
          break;
      }
    }
  }

  // Under pingEscalates the price rises mid-turn, so the plane can drop out on a leftover
  // AP.
  if (config.pings && ap >= pingCostFor(config, state.players.length, state.pingsThisTurn)) {
    for (const at of targets) {
      for (let cell = 0; cell < CELL_COUNT; cell++) ids.push(encodeAction({ type: 'PING', center: cell, at }));
    }
  }

  if (config.movement && ap >= AP_COST.MOVE) {
    const occupied = ownOccupiedCells(me);
    me.ships.forEach((ship, idx) => {
      if (ship.sunk) return;
      if (ship.hits.some(Boolean)) return; // pinned
      if (state.movedShips.includes(idx)) return; // one move per ship per turn
      // The ship's own cells are vacated by the move, so they never block it.
      const ownCells = new Set(shipCells(ship));
      const clearAt = (origin: Cell): boolean =>
        cellsFor(origin, ship.orient, ship.length).every((c) => ownCells.has(c) || !occupied.has(c));
      MOVE_DIRS.forEach((dir, dirIndex) => {
        const dest = movedOrigin(ship, dir);
        if (dest === null || !clearAt(dest)) return;
        ids.push(MOVE_BASE + idx * 4 + dirIndex);
      });
    });
  }

  if (config.decoys && ap >= AP_COST.DECOY && me.decoysPlaced < MAX_DECOYS) {
    const occupied = ownOccupiedCells(me);
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (!occupied.has(cell)) ids.push(DECOY_BASE + cell);
    }
  }

  ids.push(PASS_ID);
  return ids;
}

export function legalActions(state: GameState): Action[] {
  return legalActionIds(state).map(decodeAction);
}

// Boolean mask over the encoding, sized for this game's player count.
export function legalMask(state: GameState): boolean[] {
  const mask = new Array<boolean>(actionCount(state.players.length)).fill(false);
  for (const id of legalActionIds(state)) mask[id] = true;
  return mask;
}

export function isLegal(state: GameState, actionId: number): boolean {
  return legalActionIds(state).includes(actionId);
}
