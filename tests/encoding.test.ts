import { describe, expect, it } from 'vitest';
import {
  ACTION_COUNT,
  DECOY_BASE,
  MAX_PLAYERS,
  PASS_ID,
  SPRAY_BASE,
  TOOL_END,
  TOOL_PLANE,
  actionCount,
  baseActionId,
  decodeAction,
  encodeAction,
  legalMask,
  MOVE_DIRS,
  PRESETS,
} from '../src/engine';
import { newGame } from './helpers';

describe('canonical action encoding', () => {
  it('round-trips every assigned id', () => {
    for (let id = 0; id < ACTION_COUNT; id++) {
      if (id >= 220 && id < DECOY_BASE) continue; // retired sprint ids
      expect(encodeAction(decodeAction(id))).toBe(id);
    }
  });

  it('throws on out-of-range ids', () => {
    // Ids from ACTION_COUNT up are the extra opponents' planes, bounded by MAX_PLAYERS.
    for (const id of [-1, actionCount(MAX_PLAYERS), 10_000]) {
      expect(() => decodeAction(id)).toThrow();
    }
  });

  it('stacks extra opponents above the canonical block without disturbing it', () => {
    // Every two-player id keeps its exact meaning, and decodes without an `at`.
    for (const id of [0, 99, 100, 199, 200, 219, 224, 324]) {
      expect(encodeAction(decodeAction(id))).toBe(id);
      expect('at' in decodeAction(id)).toBe(false);
    }
    // Offset 2 (the third seat) gets its own plane: FIRE then PING.
    expect(encodeAction({ type: 'FIRE', cell: 0, at: 2 })).toBe(ACTION_COUNT);
    expect(encodeAction({ type: 'PING', center: 0, at: 2 })).toBe(ACTION_COUNT + 100);
    expect(decodeAction(ACTION_COUNT + 42)).toEqual({ type: 'FIRE', cell: 42, at: 2 });
    expect(decodeAction(ACTION_COUNT + 142)).toEqual({ type: 'PING', center: 42, at: 2 });
    // `at: 1` is the canonical plane — the same action, the same id.
    expect(encodeAction({ type: 'FIRE', cell: 7, at: 1 })).toBe(encodeAction({ type: 'FIRE', cell: 7 }));
    expect(actionCount(2)).toBe(ACTION_COUNT);
    // Three seats: the extension planes, plus the salvage-kit plane parked above every
    // extension plane MAX_PLAYERS could ever need.
    expect(actionCount(3)).toBe(TOOL_END);
  });

  it('parks the salvage kit above every seat plane, out of the duel space', () => {
    // Parked above the last FIRE/PING plane the biggest legal game could use, so the kit's
    // ids never shift with the seat count and never collide with one.
    expect(encodeAction({ type: 'PING', center: 99, at: MAX_PLAYERS - 1 })).toBeLessThan(SPRAY_BASE);
    // A duel's id space stops at PASS, so no two-player consumer can ever meet a SPRAY id.
    expect(actionCount(2)).toBeLessThan(SPRAY_BASE);
    // One plane per opponent offset, top-left addressed.
    expect(encodeAction({ type: 'SPRAY', cell: 0 })).toBe(SPRAY_BASE);
    expect(encodeAction({ type: 'SPRAY', cell: 34, at: 1 })).toBe(SPRAY_BASE + 34);
    expect(encodeAction({ type: 'SPRAY', cell: 34, at: 2 })).toBe(SPRAY_BASE + TOOL_PLANE + 34);
    expect(decodeAction(SPRAY_BASE + 34)).toEqual({ type: 'SPRAY', cell: 34, at: 1 });
    expect(decodeAction(SPRAY_BASE + TOOL_PLANE + 7)).toEqual({ type: 'SPRAY', cell: 7, at: 2 });
    // And it has no two-player form to fold down to: a rank must never be handed one.
    expect(() => baseActionId(SPRAY_BASE)).toThrow();
  });

  it('encodes PASS as 324 and MOVE as 200 + ship*4 + dirIndex', () => {
    expect(encodeAction({ type: 'PASS' })).toBe(PASS_ID);
    // MOVE_DIRS order is N,S,W,E.
    expect(encodeAction({ type: 'MOVE', ship: 0, dir: 'N' })).toBe(200);
    expect(encodeAction({ type: 'MOVE', ship: 0, dir: 'E' })).toBe(203);
    expect(encodeAction({ type: 'MOVE', ship: 3, dir: 'N' })).toBe(212);
    expect(encodeAction({ type: 'MOVE', ship: 4, dir: 'E' })).toBe(219);
    expect(encodeAction({ type: 'DECOY', cell: 99 })).toBe(DECOY_BASE + 99);
  });

  it('five ships × four directions fills 200–219 exactly, with no collisions', () => {
    const ids = new Set<number>();
    for (let ship = 0; ship < 5; ship++) {
      for (const dir of MOVE_DIRS) ids.add(encodeAction({ type: 'MOVE', ship, dir }));
    }
    expect(ids.size).toBe(20);
    expect(Math.min(...ids)).toBe(200);
    expect(Math.max(...ids)).toBe(219);
  });

  it('leaves the retired sprint ids 220–223 unassigned', () => {
    for (let id = 220; id < DECOY_BASE; id++) expect(() => decodeAction(id)).toThrow();
  });

  it('legalMask has exactly ACTION_COUNT slots', () => {
    const mask = legalMask(newGame(PRESETS.FLOTILLA));
    expect(mask).toHaveLength(ACTION_COUNT);
    expect(mask[PASS_ID]).toBe(true);
  });
});
