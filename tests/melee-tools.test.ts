import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  TOOLS,
  TOOL_BASE,
  blockCells,
  createGame,
  decodeAction,
  legalActionIds,
  mulberry32,
  observe,
  TOOL_COOLDOWN,
  redactEventsFor,
  step,
  toolsUnlocked,
  type GameState,
  type ToolId,
} from '../src/engine';
import { TEST_FLEET } from './helpers';

// SPECIAL TOOLS: four of them, one use each, MELEE only. The whole locker arms
// together the moment the fleet loses its first SHIP — there is no ramp to walk.

const rng = mulberry32(31);
const fleet = () => structuredClone(TEST_FLEET);
const melee = (seed = 7): GameState =>
  createGame(PRESETS.FLOTILLA, [fleet(), fleet(), fleet()], seed);

// Strip `n` hull cells off one fleet, carrier first. Written in directly: these tests are
// about what the RULE does at a damage level, not about how the damage got there.
function damage(state: GameState, seat: number, n: number): GameState {
  const s = structuredClone(state);
  let left = n;
  for (const ship of s.players[seat]!.ships) {
    for (let i = 0; i < ship.hits.length && left > 0; i++) {
      if (!ship.hits[i]) {
        ship.hits[i] = true;
        left--;
      }
    }
    ship.sunk = ship.hits.every(Boolean);
    if (left === 0) break;
  }
  return s;
}

// Hand the turn round the table until `seat` opens one.
function handTo(state: GameState, seat: number): GameState {
  let s = state;
  while (s.activePlayer !== seat) s = step(s, { type: 'PASS' }, rng).state;
  return s;
}

const toolIds = (s: GameState) => legalActionIds(s).filter((id) => id >= TOOL_BASE);
const armed = (s: GameState, id: ToolId) =>
  legalActionIds(s).some((x) => {
    try {
      return (decodeAction(x) as { type: string }).type === id;
    } catch {
      return false;
    }
  });

describe('special tools — one gate, the whole locker', () => {
  it('offers nothing on an undamaged board', () => {
    expect(toolIds(melee())).toEqual([]);
  });

  it('offers nothing for damage alone, however much of it', () => {
    // Four cells off the carrier: badly hurt, nothing sunk, locker shut. Under the old
    // tiered ramp this board held two tools.
    const hurt = handTo(damage(melee(), 2, 4), 2);
    expect(toolsUnlocked(hurt.players[2]!.ships)).toBe(false);
    expect(toolIds(hurt)).toEqual([]);
  });

  it('hands over every tool at once on the first ship lost', () => {
    // The fifth cell is the one that sinks the carrier — and it arms all four at a stroke.
    const blooded = handTo(damage(melee(), 2, 5), 2);
    expect(toolsUnlocked(blooded.players[2]!.ships)).toBe(true);
    for (const { id } of TOOLS) {
      expect(armed(blooded, id), `${id} missing on the first ship lost`).toBe(true);
    }
  });

  it('announces the locker once, on the sinking that opens it', () => {
    // Walk a carrier down cell by cell with real shells and count the announcements.
    let s = melee();
    const unlocks: number[] = [];
    let fired = 0;
    while (fired < 5) {
      if (s.activePlayer === 1 && s.ap >= 2) {
        const r = step(s, { type: 'FIRE', cell: fired++, at: 1 }, rng);
        s = r.state;
        for (const e of r.events) if (e.type === 'toolUnlocked') unlocks.push(e.player);
      } else {
        s = step(s, { type: 'PASS' }, rng).state;
      }
    }
    expect(unlocks).toEqual([2]);
  });

  it('never offers a tool in a duel, however battered the fleet', () => {
    const duel = createGame(PRESETS.FLOTILLA, [fleet(), fleet()], 7);
    expect(toolIds(damage(duel, 1, 15))).toEqual([]);
  });

  it('never offers or announces a tool in three-fleet CLASSIC or SALVO', () => {
    for (const preset of ['CLASSIC', 'SALVO'] as const) {
      const fresh = createGame(PRESETS[preset], [fleet(), fleet(), fleet()], 7);
      expect(toolIds(handTo(damage(fresh, 2, 15), 2)), preset).toEqual([]);
      // Real shells sinking a carrier: no locker to announce.
      let s = fresh;
      let fired = 0;
      while (fired < 5) {
        const r =
          s.activePlayer === 1 && s.ap >= 2
            ? step(s, { type: 'FIRE', cell: fired++, at: 1 }, rng)
            : step(s, { type: 'PASS' }, rng);
        s = r.state;
        expect(r.events.some((e) => e.type === 'toolUnlocked'), preset).toBe(false);
      }
      expect(s.players[2]!.ships[0]!.sunk, preset).toBe(true);
    }
  });

  it('cools each tool down for TOOL_COOLDOWN own turns, then offers it again', () => {
    let s = handTo(damage(melee(), 2, 15), 2);
    expect(armed(s, 'SCAN')).toBe(true);
    s = step(s, { type: 'SCAN', cell: 55 }, rng).state;
    expect(s.players[2]!.toolLastUsed.SCAN).toBe(s.turn);
    // Same turn: already cooling, so no second SCAN on the AP left over.
    expect(armed(s, 'SCAN')).toBe(false);
    for (let wait = TOOL_COOLDOWN - 1; wait > 0; wait--) {
      s = handTo(step(s, { type: 'PASS' }, rng).state, 2);
      expect(observe(s, 2).myToolCooldowns.SCAN).toBe(wait);
      expect(armed(s, 'SCAN')).toBe(false);
    }
    s = handTo(step(s, { type: 'PASS' }, rng).state, 2);
    expect(observe(s, 2).myToolCooldowns.SCAN).toBe(0);
    expect(armed(s, 'SCAN')).toBe(true);
  });
});

describe('special tools — what each one does', () => {
  // Seat 2, fully unlocked and on its own turn.
  const ready = () => handTo(damage(melee(), 2, 12), 2);

  it('SPRAY puts four shells in a 2×2 on one board', () => {
    const s = ready();
    const before = s.shots.length;
    const r = step(s, { type: 'SPRAY', cell: 0 }, rng);
    const fired = r.state.shots.slice(before);
    expect(fired.map((x) => x.cell)).toEqual([0, 1, 10, 11]);
    expect(fired.every((x) => x.target === 0)).toBe(true);
  });

  it('FORK puts the same cell into BOTH enemy boards', () => {
    const s = ready();
    const before = s.shots.length;
    const r = step(s, { type: 'FORK', cell: 0 }, rng);
    const fired = r.state.shots.slice(before);
    expect(fired).toHaveLength(2);
    expect(fired.map((x) => x.cell)).toEqual([0, 0]);
    expect(fired.map((x) => x.target).sort()).toEqual([0, 1]);
  });

  it('SCAN sweeps a 2×2 — half a ping’s footprint', () => {
    const s = ready();
    const r = step(s, { type: 'SCAN', cell: 0 }, rng);
    const e = r.events.find((x) => x.type === 'scan')!;
    expect(e).toMatchObject({ type: 'scan', contact: true, target: 0 });
    expect(e.type === 'scan' && e.cells).toEqual([0, 1, 10, 11]);
    // The canonical fleet sits on even rows, so the 2×2 at 15 (15,16,25,26) is open water.
    const clear = step(ready(), { type: 'SCAN', cell: 15 }, rng);
    expect(clear.events.find((x) => x.type === 'scan')).toMatchObject({ contact: false });
  });

  it('ECHO sweeps 4×4 and tells EVERY seat what it found', () => {
    const s = ready();
    const r = step(s, { type: 'ECHO', cell: 0 }, rng);
    const e = r.events.find((x) => x.type === 'echo')!;
    expect(e.type === 'echo' && e.cells).toEqual(blockCells(0, 4));
    expect(e).toMatchObject({ contact: true, by: 2, target: 0 });
    // Public at every end — the fleet that was lit sees it too, which no ping ever allows.
    for (const seat of [0, 1, 2]) {
      expect(redactEventsFor(seat, r.events).some((x) => x.type === 'echo')).toBe(true);
    }
  });

  it('SCAN marks exactly which cells are live; ECHO reports the OCCUPANCY of its block', () => {
    const s = ready();
    // Seat 0's carrier lies along row 0 (cells 0-4), so the 2x2 at 0 is live on top only.
    const scan = step(s, { type: 'SCAN', cell: 0 }, rng);
    expect(scan.state.players[2]!.pings).toEqual([0, 1, 10, 11].map((c) => (
      { center: c, cells: [c], contact: c < 10, turn: s.turn, target: 0 }
    )));
    expect(scan.events.find((e) => e.type === 'scan')).toMatchObject({ live: [0, 1] });
    // The 4x4 at 0 holds carrier 0-3 and battleship 20-23: OCCUPANCY 8.
    const echoed = step(s, { type: 'ECHO', cell: 0 }, rng).state;
    expect(echoed.players[2]!.pings).toEqual([
      { center: 0, cells: blockCells(0, 4), contact: true, occupancy: 8, turn: s.turn, target: 0 },
    ]);
  });

  it('a public ECHO lands on every seat’s chart but the one it lit', () => {
    const r = step(ready(), { type: 'ECHO', cell: 0 }, rng);
    expect(r.state.players[2]!.pings).toHaveLength(1);
    // The bystander files the caster's answer verbatim; the fleet that was lit files
    // nothing — it is looking at its own water, where there is no intel to hold.
    expect(r.state.players[1]!.pings).toEqual(r.state.players[2]!.pings);
    expect(r.state.players[0]!.pings).toEqual([]);
    // And it READS as intel about the board that was lit, so the bystander's targeting
    // grid washes it exactly as if they had swept that water themselves.
    const bystander = observe(r.state, 1);
    expect(bystander.intel[0]!.pings).toEqual(r.state.players[2]!.pings);
    expect(bystander.intel[2]!.pings).toEqual([]);
  });

  it('an aimed sweep reads the board it names, not the next seat along', () => {
    // Seat 1's carrier and battleship are already on the bottom, so with live-only sonar the
    // block that lights seat 0 up comes back CLEAR off seat 1 — the answers tell the two
    // boards apart, not just the label on the event.
    const s = handTo(damage(damage(melee(), 2, 12), 1, 9), 2);
    expect(step(s, { type: 'ECHO', cell: 0 }, rng).events.find((e) => e.type === 'echo')).toMatchObject(
      { target: 0, contact: true },
    );
    const far = step(s, { type: 'ECHO', cell: 0, at: 2 }, rng);
    expect(far.events.find((e) => e.type === 'echo')).toMatchObject({ target: 1, contact: false });
    expect(far.state.players[2]!.pings[0]).toMatchObject({ target: 1, contact: false });
    const farScan = step(s, { type: 'SCAN', cell: 0, at: 2 }, rng);
    expect(farScan.events.find((e) => e.type === 'scan')).toMatchObject({ target: 1, contact: false });
    expect(farScan.state.players[2]!.pings[0]).toMatchObject({ target: 1, contact: false });
  });
});
