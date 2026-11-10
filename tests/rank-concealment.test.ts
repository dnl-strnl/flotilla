import { describe, expect, it } from 'vitest';
import type { BotName } from '../src/ai';
import { concealsRanks, initialState, reducer, type AppState, type Setup } from '../src/ui/state';

// Start a session the way DEPLOY does: a setup from the menu, then the human through
// placement. Fleet layout is irrelevant here — only who ends up in which seat is.
function sessionFor(patch: Partial<Setup>) {
  const setup: Setup = { ...initialState.setup, ...patch };
  let app: AppState = reducer(initialState, { t: 'START_SETUP', setup });
  if (app.screen.kind === 'placement') {
    app = reducer(app, { t: 'RANDOMIZE_PLACEMENT' });
    app = reducer(app, { t: 'CONFIRM_PLACEMENT' });
  }
  return app.session!;
}

const botsFor = (patch: Partial<Setup>): (BotName | null)[] => sessionFor(patch).bots;
const concealedFor = (patch: Partial<Setup>): boolean => sessionFor(patch).concealed;

const MELEE = { mode: 'open' as const, human: true };

describe('rank concealment', () => {
  it('seats a lone opponent exactly where the menu put it', () => {
    const bots = botsFor({ mode: 'duel', human: true, cpuA: 'admiral' });
    expect(bots).toEqual([null, 'admiral']);
    expect(concealedFor({ mode: 'duel', human: true, cpuA: 'admiral' })).toBe(false);
  });

  it('keeps the menu order for a fleet exercise — nobody is being kept in the dark', () => {
    const patch = {
      mode: 'open' as const,
      human: false,
      cpuA: 'ensign' as const,
      cpuB: 'captain' as const,
      cpuC: 'admiral' as const,
    };
    expect(botsFor(patch)).toEqual(['ensign', 'captain', 'admiral']);
    expect(concealedFor(patch)).toBe(false);
  });

  it('fields the lineup the menu picked, human still on seat 0', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const bots = botsFor({ ...MELEE, cpuA: 'admiral', cpuB: 'ensign', seed });
      expect(bots[0]).toBe(null);
      expect([...bots.slice(1)].sort()).toEqual(['admiral', 'ensign']);
    }
  });

  it('shuffles which seat each rank takes, so the menu order is not the seating', () => {
    const seatings = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      seatings.add(botsFor({ ...MELEE, cpuA: 'admiral', cpuB: 'ensign', seed }).join(','));
    }
    // Both orders have to turn up, or the "shuffle" is dealing the menu order every time.
    expect(seatings).toEqual(new Set([',admiral,ensign', ',ensign,admiral']));
  });

  it('deals the same seating back for the same seed', () => {
    const patch = { ...MELEE, cpuA: 'admiral' as const, cpuB: 'ensign' as const, seed: 7 };
    expect(botsFor(patch)).toEqual(botsFor(patch));
  });

  it('marks a multi-rank melee concealed and a mirror plain', () => {
    const base = { ...MELEE, seed: 3 };
    expect(concealedFor({ ...base, cpuA: 'admiral', cpuB: 'ensign' })).toBe(true);
    // Both fleets are the same rank: a label there gives away nothing the menu did not.
    expect(concealedFor({ ...base, cpuA: 'admiral', cpuB: 'admiral' })).toBe(false);
    expect(botsFor({ ...base, cpuA: 'admiral', cpuB: 'admiral' })).toEqual([
      null,
      'admiral',
      'admiral',
    ]);
  });

  it('concealsRanks is the one rule both the menu and the roster read', () => {
    expect(concealsRanks(['admiral'], true)).toBe(false);
    expect(concealsRanks(['admiral', 'ensign'], true)).toBe(true);
    expect(concealsRanks(['admiral', 'admiral'], true)).toBe(false);
    expect(concealsRanks(['admiral', 'ensign'], false)).toBe(false);
  });
});
