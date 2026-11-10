import { MAX_PLAYERS, MOVE_DIRS, type Action, type MoveDir } from './types';

// Canonical flat action encoding: FIRE 0–99, PING 100–199, MOVE 200–219, DECOY 224–323,
// PASS 324. 220–223 belonged to the retired Mako sprint and stay unassigned, so every id
// above keeps its meaning.
export const ACTION_COUNT = 325;
export const FIRE_BASE = 0;
export const PING_BASE = 100;
export const MOVE_BASE = 200;
export const DECOY_BASE = 224;
export const PASS_ID = 324;

// Extra opponents get FIRE/PING planes stacked ABOVE the canonical block, so ids 0–324 keep
// their two-player meaning (offset 1 = the next seat).
export const EXT_BASE = ACTION_COUNT;
export const EXT_STRIDE = 200;

// SPECIAL-TOOL planes, parked above every extension plane so ids never depend on seat
// count. Aimed tools get one plane per opponent offset: BASE + (at-1)*100 + cell. FORK hits
// every board at once, so it has a single plane.
export const SPRAY_BASE = EXT_BASE + (MAX_PLAYERS - 2) * EXT_STRIDE;
export const TOOL_PLANE = 100;
const AIMED_SPAN = (MAX_PLAYERS - 1) * TOOL_PLANE;
export const SCAN_BASE = SPRAY_BASE + AIMED_SPAN;
export const ECHO_BASE = SCAN_BASE + AIMED_SPAN;
export const FORK_BASE = ECHO_BASE + AIMED_SPAN;
export const TOOL_END = FORK_BASE + TOOL_PLANE;

// Every id at or above this is a special tool, whatever kind.
export const TOOL_BASE = SPRAY_BASE;

const aimed = (base: number, at: number, cell: number) => base + (at - 1) * TOOL_PLANE + cell;

// Size of the id space for an N-player game. Two players = ACTION_COUNT, as always.
export function actionCount(playerCount: number): number {
  return playerCount < 3 ? ACTION_COUNT : TOOL_END;
}

export function encodeAction(action: Action): number {
  switch (action.type) {
    case 'FIRE': {
      const at = action.at ?? 1;
      if (at === 1) return FIRE_BASE + action.cell;
      return EXT_BASE + (at - 2) * EXT_STRIDE + action.cell;
    }
    case 'PING': {
      const at = action.at ?? 1;
      if (at === 1) return PING_BASE + action.center;
      return EXT_BASE + (at - 2) * EXT_STRIDE + 100 + action.center;
    }
    case 'SPRAY':
      return aimed(SPRAY_BASE, action.at ?? 1, action.cell);
    case 'SCAN':
      return aimed(SCAN_BASE, action.at ?? 1, action.cell);
    case 'ECHO':
      return aimed(ECHO_BASE, action.at ?? 1, action.cell);
    case 'FORK':
      return FORK_BASE + action.cell;
    case 'MOVE':
      return MOVE_BASE + action.ship * 4 + MOVE_DIRS.indexOf(action.dir);
    case 'DECOY':
      return DECOY_BASE + action.cell;
    case 'PASS':
      return PASS_ID;
  }
}

export function decodeAction(id: number): Action {
  if (id >= FIRE_BASE && id < PING_BASE) return { type: 'FIRE', cell: id - FIRE_BASE };
  if (id >= PING_BASE && id < MOVE_BASE) return { type: 'PING', center: id - PING_BASE };
  if (id >= MOVE_BASE && id < MOVE_BASE + 20) {
    const offset = id - MOVE_BASE;
    return { type: 'MOVE', ship: Math.floor(offset / 4), dir: MOVE_DIRS[offset % 4] as MoveDir };
  }
  if (id >= DECOY_BASE && id < PASS_ID) return { type: 'DECOY', cell: id - DECOY_BASE };
  if (id === PASS_ID) return { type: 'PASS' };
  if (id >= TOOL_BASE) {
    if (id >= TOOL_END) throw new Error(`invalid action id: ${id}`);
    if (id >= FORK_BASE) return { type: 'FORK', cell: id - FORK_BASE };
    const base = id >= ECHO_BASE ? ECHO_BASE : id >= SCAN_BASE ? SCAN_BASE : SPRAY_BASE;
    const at = Math.floor((id - base) / TOOL_PLANE) + 1;
    const cell = (id - base) % TOOL_PLANE;
    if (base === SPRAY_BASE) return { type: 'SPRAY', cell, at };
    if (base === SCAN_BASE) return { type: 'SCAN', cell, at };
    return { type: 'ECHO', cell, at };
  }
  if (id >= EXT_BASE && id < TOOL_BASE) {
    const at = Math.floor((id - EXT_BASE) / EXT_STRIDE) + 2;
    const rem = (id - EXT_BASE) % EXT_STRIDE;
    return rem < 100
      ? { type: 'FIRE', cell: rem, at }
      : { type: 'PING', center: rem - 100, at };
  }
  throw new Error(`invalid action id: ${id}`);
}

// Fold an id from any opponent's plane down to its canonical 0–324 form. The melee adapter
// hands bots ONLY canonical ids: some bots test a raw CELL against legal ids (FIRE_BASE =
// 0).
export function baseActionId(id: number): number {
  // Tools have no two-player form; folding one would read as a FIRE at an unchosen cell.
  if (id >= TOOL_BASE) throw new Error(`tool id ${id} has no canonical two-player form`);
  if (id < EXT_BASE) return id;
  const rem = (id - EXT_BASE) % EXT_STRIDE;
  return rem < 100 ? FIRE_BASE + rem : PING_BASE + (rem - 100);
}
