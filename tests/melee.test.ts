import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  createGame,
  exportReplay,
  legalActionIds,
  maxTurnsFor,
  mulberry32,
  observe,
  redactEventsFor,
  runReplay,
  shipCells,
  step,
  type Action,
  type Event,
  type GameState,
} from '../src/engine';
import { TEST_FLEET } from './helpers';

const SEED = 7;

function melee(config = PRESETS.FLOTILLA, seed = SEED): GameState {
  return createGame(
    config,
    [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    seed,
  );
}

const rng = mulberry32(99);
const play = (state: GameState, actions: Action[]) => {
  let s = state;
  const events: Event[] = [];
  for (const a of actions) {
    const r = step(s, a, rng);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
};

// Walk `turns` handoffs by passing, recording who held each one.
function seatSequence(state: GameState, turns: number): number[] {
  let s = state;
  const seats = [s.activePlayer];
  for (let i = 1; i < turns; i++) {
    s = step(s, { type: 'PASS' }, rng).state;
    if (s.phase.kind !== 'playing') break;
    seats.push(s.activePlayer);
  }
  return seats;
}

describe('MELEE turn order', () => {
  it('gives every seat exactly one turn per round', () => {
    const seats = seatSequence(melee(), 30);
    for (let round = 0; round < 10; round++) {
      expect([...seats.slice(round * 3, round * 3 + 3)].sort()).toEqual([0, 1, 2]);
    }
  });

  it('never lets a seat act twice in a row, across round boundaries included', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const seats = seatSequence(melee(PRESETS.FLOTILLA, seed), 60);
      for (let i = 1; i < seats.length; i++) {
        expect(seats[i], `seed ${seed}, turn ${i + 1}`).not.toBe(seats[i - 1]);
      }
    }
  });

  it('runs a fixed round-robin, the same every round and on every seed', () => {
    // Predictable by design: with shot results public there is nothing for an
    // unpredictable order to protect, and knowing who answers next is what makes the turn
    // you hand over something you can plan around. See order.ts.
    for (const seed of [1, 7, 99]) {
      expect(seatSequence(melee(PRESETS.FLOTILLA, seed), 9)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    }
  });

  it('leaves two-player alternation untouched', () => {
    const duel = createGame(PRESETS.FLOTILLA, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], SEED);
    expect(seatSequence(duel, 8)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('caps at 100 rounds each — 301 turns for three fleets', () => {
    expect(maxTurnsFor(2)).toBe(201);
    expect(maxTurnsFor(3)).toBe(301);
  });
});

describe('MELEE targeting', () => {
  it('damages only the named board', () => {
    const start = melee();
    const me = start.activePlayer;
    const far = (me + 2) % 3;
    // Cell 0 is the carrier's bow on every fleet, so a mis-routed shot would show.
    const r = play(start, [{ type: 'FIRE', cell: 0, at: 2 }]);
    expect(r.state.players[far]!.ships[0]!.hits[0]).toBe(true);
    expect(r.state.players[(me + 1) % 3]!.ships[0]!.hits[0]).toBe(false);
    expect(r.state.shots[0]).toMatchObject({ by: me, target: far, cell: 0, result: 'HIT' });
  });

  it('offers a FIRE and a PING plane for each opponent', () => {
    const ids = legalActionIds(melee());
    // 100 cells × 2 opponents for FIRE, the same for PING, plus moves/decoys/pass.
    expect(ids.filter((id) => id < 100)).toHaveLength(100);
    expect(ids.filter((id) => id >= 325 && id < 425)).toHaveLength(100);
    expect(ids.filter((id) => id >= 100 && id < 200)).toHaveLength(100);
    expect(ids.filter((id) => id >= 425 && id < 525)).toHaveLength(100);
  });

  it('sweeps sonar over the named fleet only', () => {
    const start = melee();
    const me = start.activePlayer;
    const near = (me + 1) % 3;
    // Slide the near fleet's cruiser away so the two boards differ at cell 40.
    const moved = play(start, [{ type: 'PASS' }]);
    const r = play(moved.state, [{ type: 'PING', center: 40, at: 2 }]);
    const ping = r.state.players[moved.state.activePlayer]!.pings[0]!;
    expect(ping.target).toBe((moved.state.activePlayer + 2) % 3);
    expect(ping.target).not.toBe(near);
  });

  it('retires a destroyed fleet\'s planes and leaves the survivor\'s ids alone', () => {
    let s = melee();
    const killer = s.activePlayer;
    const victim = (killer + 1) % 3;
    const hull = s.players[victim]!.ships.flatMap(shipCells);
    let guard = 0;
    // Only the opening seat fires; everyone else passes.
    while (s.phase.kind === 'playing' && hull.length > 0 && guard++ < 400) {
      if (s.activePlayer === killer && s.ap >= 2) {
        s = step(s, { type: 'FIRE', cell: hull.shift()!, at: 1 }, rng).state;
      } else {
        s = step(s, { type: 'PASS' }, rng).state;
      }
    }
    while (s.activePlayer !== killer) s = step(s, { type: 'PASS' }, rng).state;

    const ids = legalActionIds(s);
    // The canonical 0-99 / 100-199 block is offset 1 — now a wreck — and is gone. The
    // bystander keeps the extension plane it has had since turn 1 rather than being
    // renumbered down into the vacated block.
    expect(ids.filter((id) => id < 100)).toHaveLength(0);
    expect(ids.filter((id) => id >= 100 && id < 200)).toHaveLength(0);
    expect(ids.filter((id) => id >= 325 && id < 425)).toHaveLength(100);
    expect(ids.filter((id) => id >= 425 && id < 525)).toHaveLength(100);
  });
});

describe('MELEE attribution', () => {
  it('shows a bystander who fired at whom, without the private truth', () => {
    const start = melee();
    const me = start.activePlayer;
    const victim = (me + 1) % 3;
    const bystander = (me + 2) % 3;
    const r = play(start, [{ type: 'FIRE', cell: 0, at: 1 }]);

    const seen = redactEventsFor(bystander, r.events).filter((e) => e.type === 'fire');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'fire', turn: 1, by: me, target: victim, cell: 0, reported: 'HIT' });
    // Public at both ends, but the defender's secrets stay behind.
    expect(seen[0]).not.toHaveProperty('hitShip');
    expect(seen[0]).not.toHaveProperty('decoy');
  });

  it('gives the victim the full truth about their own board', () => {
    const start = melee();
    const me = start.activePlayer;
    const victim = (me + 1) % 3;
    const r = play(start, [{ type: 'FIRE', cell: 0, at: 1 }]);
    const seen = redactEventsFor(victim, r.events).find((e) => e.type === 'fire')!;
    expect(seen).toMatchObject({ by: me, target: victim, hitShip: 'carrier' });
  });

  it('records the shooter on incoming fire, so a defender knows who hit them', () => {
    const start = melee();
    const me = start.activePlayer;
    const victim = (me + 1) % 3;
    const r = play(start, [{ type: 'FIRE', cell: 0, at: 1 }]);
    expect(r.state.players[victim]!.shotsReceived[0]).toEqual({ cell: 0, turn: 1, by: me });
    expect(observe(r.state, victim).shotsAgainstMe[0]).toMatchObject({ by: me });
  });

  it('leaves a private action an opaque blip that still names the actor', () => {
    const start = melee();
    const me = start.activePlayer;
    const r = play(start, [{ type: 'PING', center: 40, at: 1 }]);
    for (const seat of [0, 1, 2].filter((s) => s !== me)) {
      const blips = redactEventsFor(seat, r.events).filter((e) => e.type === 'enemyActivity');
      expect(blips).toEqual([{ type: 'enemyActivity', turn: 1, player: me }]);
    }
  });

  it('keeps two-player incoming fire unattributed, exactly as before', () => {
    const duel = createGame(PRESETS.FLOTILLA, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], SEED);
    const r = play(duel, [{ type: 'FIRE', cell: 0 }]);
    expect(r.state.players[1].shotsReceived[0]).toEqual({ cell: 0, turn: 1 });
    const seen = redactEventsFor(1, r.events).find((e) => e.type === 'fire')!;
    expect(seen).toMatchObject({ by: 0, target: 1, hitShip: 'carrier' });
  });
});

describe('MELEE observation', () => {
  it('splits intel per enemy board and leaves my own seat null', () => {
    const start = melee();
    const me = start.activePlayer;
    const r = play(start, [{ type: 'FIRE', cell: 0, at: 2 }]);
    const obs = observe(r.state, me);

    expect(obs.playerCount).toBe(3);
    expect(obs.intel[me]).toBeNull();
    expect(obs.intel[(me + 1) % 3]!.shots).toEqual([]);
    // `mine` marks the viewer's own shells in the pooled public record.
    expect(obs.intel[(me + 2) % 3]!.shots).toEqual([
      { cell: 0, result: 'HIT', turn: 1, by: me },
    ]);
    expect(obs.intel[(me + 2) % 3]!.shipsRemaining).toBe(5);
  });

  it('shares a bystander the public damage record without the shooter', () => {
    const start = melee();
    const me = start.activePlayer;
    const victim = (me + 1) % 3;
    const bystander = (me + 2) % 3;
    const obs = observe(play(start, [{ type: 'FIRE', cell: 0, at: 1 }]).state, bystander);
    // The bystander learns the hit on the victim's board purely from the public log.
    expect(obs.intel[victim]!.shots).toEqual([{ cell: 0, result: 'HIT', turn: 1, by: me }]);
    // …but it is not THEIR shot, so their own-fire record stays empty.
    expect(obs.myShots).toEqual([]);
  });
});

describe('MELEE replays', () => {
  it('round-trips a three-fleet game as version 3, order and all', () => {
    const start = melee();
    const actions: Action[] = [
      { type: 'FIRE', cell: 0, at: 1 },
      { type: 'PASS' },
      { type: 'PING', center: 40, at: 2 },
      { type: 'PASS' },
      { type: 'FIRE', cell: 1, at: 2 },
      { type: 'PASS' },
    ];
    const r = play(start, actions);
    const replay = exportReplay(
      start.config,
      SEED,
      start.firstPlayer,
      [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
      actions,
      r.events,
    );
    expect(replay.version).toBe(3);
    const rerun = runReplay(JSON.parse(JSON.stringify(replay)));
    expect(rerun.state.shots).toEqual(r.state.shots);
    expect(rerun.state.activePlayer).toBe(r.state.activePlayer);
    expect(rerun.state.players).toEqual(r.state.players);
  });

  it('still replays a pre-OPEN-WATER v2 file: no `at`, retired knob fields', () => {
    // A replay exported before any of this existed. Actions carry no target, the config
    // still carries long-retired knobs, and the stored events predate the `target` field —
    // it has to re-execute as the two-player game it was.
    const legacy = {
      version: 2 as const,
      config: { ...PRESETS.FLOTILLA, moveWake: true, makoSprint: false },
      seed: SEED,
      firstPlayer: 0,
      autoEndTurn: true,
      placements: [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)] as [
        typeof TEST_FLEET,
        typeof TEST_FLEET,
      ],
      actions: [{ type: 'FIRE' as const, cell: 0 }, { type: 'FIRE' as const, cell: 1 }],
      events: [],
    };
    const rerun = runReplay(JSON.parse(JSON.stringify(legacy)));
    expect(rerun.state.shots.map((s) => s.cell)).toEqual([0, 1]);
    // Untargeted actions still mean "the only opponent".
    expect(rerun.state.shots.every((s) => s.by === 0 && s.target === 1)).toBe(true);
    expect(rerun.state.players[1].ships[0]!.hits.slice(0, 2)).toEqual([true, true]);
  });

  it('still exports two fleets as version 2', () => {
    const duel = createGame(PRESETS.FLOTILLA, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], SEED);
    const replay = exportReplay(duel.config, SEED, 0, [TEST_FLEET, TEST_FLEET], [], []);
    expect(replay.version).toBe(2);
  });
});
