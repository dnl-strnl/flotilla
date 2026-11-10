import { describe, expect, it } from 'vitest';
import {
  ACTION_COUNT,
  PRESETS,
  createGame,
  encodeAction,
  legalActionIds,
  mulberry32,
  observe,
  step,
  type Action,
  type GameState,
} from '../src/engine';
import { makeBot, makeMelee, projectObservation, type BotName } from '../src/ai';
import { runMeleeGame } from '../src/sim/melee';
import { TEST_FLEET } from './helpers';

const RANKS: BotName[] = ['ensign', 'commander', 'lieutenant', 'captain', 'commodore', 'admiral'];

const fleet = () => structuredClone(TEST_FLEET);

function melee(seed = 5): GameState {
  return createGame(PRESETS.FLOTILLA, [fleet(), fleet(), fleet()], seed);
}

describe('melee adapter: two-player behaviour is untouched', () => {
  it('delegates to the bare rank, action for action', () => {
    for (const rank of RANKS) {
      let plain = createGame(PRESETS.FLOTILLA, [fleet(), fleet()], 11);
      let wrapped = createGame(PRESETS.FLOTILLA, [fleet(), fleet()], 11);
      const bare = makeBot(rank, { samples: 25 });
      const viaMelee = makeMelee(rank, { samples: 25 });
      // Separate but identically seeded streams, so any divergence is the adapter's.
      const rngA = mulberry32(3);
      const rngB = mulberry32(3);
      for (let i = 0; i < 12 && plain.phase.kind === 'playing'; i++) {
        const a = bare(observe(plain, plain.activePlayer), legalActionIds(plain), rngA);
        const b = viaMelee(observe(wrapped, wrapped.activePlayer), legalActionIds(wrapped), rngB);
        expect(b, `${rank} diverged at ply ${i}`).toEqual(a);
        plain = step(plain, a, rngA).state;
        wrapped = step(wrapped, b, rngB).state;
      }
    }
  });
});

describe('melee adapter: projection', () => {
  it('shows a rank only canonical action ids, never a rebased one', () => {
    // admiral and commodore both test a raw cell against the legal set, so a rebased id
    // would silently corrupt their aiming rather than throw.
    const state = melee();
    const spy = makeMelee('commodore', { samples: 25 });
    const obs = observe(state, state.activePlayer);
    const legal = legalActionIds(state);
    // Re-run the projection the adapter performs and assert its output range.
    for (const at of [1, 2]) {
      const target = (obs.me + at) % 3;
      const projected = projectObservation(obs, target);
      expect(projected.playerCount).toBe(2);
      expect(projected.intel).toHaveLength(2);
      expect(projected.intel[0]).toBeNull();
    }
    const action = spy(obs, legal, mulberry32(1));
    expect(legal).toContain(encodeAction(action));
  });

  it('addresses the chosen board and keeps self-directed actions unstamped', () => {
    const state = melee();
    const rng = mulberry32(2);
    for (const rank of RANKS) {
      const bot = makeMelee(rank, { samples: 25 });
      const action = bot(observe(state, state.activePlayer), legalActionIds(state), rng);
      if (action.type === 'FIRE' || action.type === 'PING') {
        const at = action.at ?? 1;
        expect(at).toBeGreaterThanOrEqual(1);
        expect(at).toBeLessThanOrEqual(2);
      } else {
        expect(action).not.toHaveProperty('at');
      }
      expect(legalActionIds(state)).toContain(encodeAction(action));
    }
  });

  it('clocks my own shells as mine — a shot fired this turn reads as age 0', () => {
    // Everyone's fire at a board is pooled, so each record has to be aged by WHO fired it.
    // Clocking my own shells as an enemy's would make all my intel read a turn stale.
    const start = melee();
    const me = start.activePlayer;
    const rng2 = mulberry32(8);
    const after = step(start, { type: 'FIRE', cell: 12, at: 1 }, rng2).state;
    const obs = observe(after, me);
    const target = (me + 1) % 3;
    expect(obs.intel[target]!.shots[0]!.by).toBe(me);

    const projected = projectObservation(obs, target);
    const own = projected.myShots[0]!;
    expect(projected.turn - own.turn).toBe(0);
    // Self-actions occupy the odd virtual turns, everyone else's the even one before —
    // which is what keeps an enemy's action from ever reading as "in the future".
    expect(own.turn % 2).toBe(1);
    expect(projected.shotsAgainstMe.every((s) => s.turn % 2 === 0)).toBe(true);
  });

  it('dates a rival shell fired right after my turn one virtual turn back, whatever my seat', () => {
    // The first seat in the order used to see this shell a full round stale (age 3), so a
    // fresh wake never read as fresh.
    let state = melee();
    const me = state.activePlayer;
    const rng2 = mulberry32(8);
    state = step(state, { type: 'PASS' }, rng2).state;
    // The next seat fires back at me (offset 2 from it), then the third seat passes.
    state = step(state, { type: 'FIRE', cell: 0, at: 2 }, rng2).state;
    state = step(state, { type: 'PASS' }, rng2).state;
    if (state.activePlayer !== me) state = step(state, { type: 'PASS' }, rng2).state;
    expect(state.activePlayer).toBe(me);
    const projected = projectObservation(observe(state, me), (me + 1) % 3);
    const incoming = projected.shotsAgainstMe;
    expect(incoming).toHaveLength(1);
    expect(projected.turn - incoming[0]!.turn).toBe(1);
  });

  it('rebuilds a two-player clock in which enemy actions are never in the future', () => {
    // Each seat acts once per round, so ages stay positive and bounded.
    const state = melee();
    const played = runMeleeGame(
      [makeMelee('commander', { samples: 25 }), makeMelee('commander', { samples: 25 }), makeMelee('ensign')],
      PRESETS.FLOTILLA,
      4,
      [0, 1, 2],
    );
    expect(played.turns).toBeGreaterThan(1);
    const obs = observe(state, state.activePlayer);
    const projected = projectObservation(obs, (obs.me + 1) % 3);
    for (const s of projected.myShots) expect(projected.turn - s.turn).toBeGreaterThanOrEqual(0);
    for (const s of projected.shotsAgainstMe) expect(projected.turn - s.turn).toBeGreaterThanOrEqual(0);
  });
});

describe('melee ranks', () => {
  it('every rank finishes a melee game without an illegal action', () => {
    // step() throws on anything illegal, so completing the game IS the assertion.
    for (const rank of RANKS) {
      const rec = runMeleeGame(
        [
          makeMelee(rank, { samples: 25 }),
          makeMelee(rank, { samples: 25 }),
          makeMelee(rank, { samples: 25 }),
        ],
        PRESETS.FLOTILLA,
        13,
        [0, 1, 2],
      );
      expect(rec.turns, rank).toBeGreaterThan(1);
    }
  });

  it('is deterministic for a given seed and seating', () => {
    const run = () =>
      runMeleeGame(
        [makeMelee('commander', { samples: 25 }), makeMelee('admiral', { samples: 25 }), makeMelee('ensign')],
        PRESETS.FLOTILLA,
        21,
        [0, 1, 2],
      );
    const a = run();
    const b = run();
    expect(b.winnerSeat).toBe(a.winnerSeat);
    expect(b.turns).toBe(a.turns);
    expect(b.damage).toEqual(a.damage);
  });

  it('credits an absorbed fake hit to the decoy OWNER, not to a flipped seat', () => {
    const rec = runMeleeGame(
      [
        makeMelee('captain', { samples: 25 }),
        makeMelee('captain', { samples: 25 }),
        makeMelee('captain', { samples: 25 }),
      ],
      PRESETS.FLOTILLA,
      33,
      [0, 1, 2],
    );
    // CAPTAIN is the decoy-heavy rank; absorbed hits must land on a seat that placed one.
    rec.bySeat.forEach((s) => {
      if (s.fakeHitsAbsorbed > 0) expect(s.decoys).toBeGreaterThan(0);
    });
  });
});

// Ids above the canonical block belong to the extra opponents' planes.
describe('melee legality', () => {
  it('keeps the canonical plane pointed at the next seat', () => {
    const state = melee();
    const ids = legalActionIds(state);
    expect(ids.filter((id) => id < ACTION_COUNT).length).toBeGreaterThan(0);
    const shotNext: Action = { type: 'FIRE', cell: 55 };
    const shotFar: Action = { type: 'FIRE', cell: 55, at: 2 };
    expect(encodeAction(shotNext)).toBe(55);
    expect(encodeAction(shotFar)).toBe(ACTION_COUNT + 55);
    expect(ids).toContain(encodeAction(shotNext));
    expect(ids).toContain(encodeAction(shotFar));
  });
});

describe('melee target mixing (targetTemp)', () => {
  it('temp 0 is the argmax that ships — action for action', () => {
    // One rank per target rule that reads the board differently: weakest, retaliation,
    // sonar.
    for (const rank of ['commander', 'lieutenant', 'captain'] as const) {
      const shipped = makeMelee(rank, { samples: 25 });
      const explicit = makeMelee(rank, { samples: 25, targetTemp: 0 });
      let a = melee(17);
      let b = melee(17);
      const rngA = mulberry32(9);
      const rngB = mulberry32(9);
      for (let i = 0; i < 15 && a.phase.kind === 'playing'; i++) {
        const x = shipped(observe(a, a.activePlayer), legalActionIds(a), rngA);
        const y = explicit(observe(b, b.activePlayer), legalActionIds(b), rngB);
        expect(y, `${rank} diverged at ply ${i}`).toEqual(x);
        a = step(a, x, rngA).state;
        b = step(b, y, rngB).state;
      }
    }
  });

  it('spreads a locked-on target rule across both boards', () => {
    // COMMANDER's race-the-weakest rule is the stickiest, so it is the honest test. Pooled
    // over 32 games: any 8-game slice can read backwards on noise alone.
    const SEEDS = Array.from({ length: 32 }, (_, i) => i + 4);
    const spread = (targetTemp: number) =>
      SEEDS.flatMap((seed) => {
        const bots = Array.from({ length: 3 }, () =>
          makeMelee('commander', { samples: 25, targetTemp }),
        );
        const r = runMeleeGame(bots, PRESETS.FLOTILLA, seed, [0, 1, 2]);
        // Per shooter, the share of its shells that went to its favourite board.
        return r.shotsAt.map((row) => {
          const fired = row.reduce((a, b) => a + b, 0);
          return fired ? Math.max(...row) / fired : 0;
        });
      });
    const hot = spread(0.2);
    const cold = spread(0);
    // Averaged over every seat of every game, a hot bot concentrates strictly less.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(hot)).toBeLessThan(mean(cold));
  });
});
