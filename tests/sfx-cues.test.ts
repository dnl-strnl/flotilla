import { describe, expect, it } from 'vitest';
import { PRESETS, redactEventsFor, type Event, type PlayerId, type Replay } from '../src/engine';
import { beatsForEvents, beatsForTransition } from '../src/ui/sfx/cues';
import { SLOT_IDS, duckRepeat, pickVariant } from '../src/ui/sfx/slots';
import type { AppState } from '../src/ui/state';
import { TEST_FLEET } from './helpers';

// Cues are a pure mapping from redacted events: a decoy must sound exactly like a hit,
// and the opponent's private actions must all sound the same.

const cues = (events: Event[], me: 0 | 1) =>
  beatsForEvents(redactEventsFor(me, events), me).map((b) => b.cue);

describe('sfx cues', () => {
  it('a decoy is indistinguishable from a real hit to the shooter', () => {
    const real: Event = { type: 'fire', turn: 3, by: 0, target: 1, cell: 44, reported: 'HIT', hitShip: 'cruiser' };
    const fake: Event = { type: 'fire', turn: 3, by: 0, target: 1, cell: 44, reported: 'HIT', decoy: true };
    expect(cues([real], 0)).toEqual(['fire.send', 'fire.hit']);
    expect(cues([fake], 0)).toEqual(cues([real], 0));
  });

  it('every private enemy action collapses to one cue', () => {
    const ping: Event = { type: 'ping', turn: 2, by: 1, target: 0, center: 44, cells: [44], contact: true };
    const move: Event = { type: 'move', turn: 2, player: 1, ship: 0, dir: 'N', from: 44, to: 34 };
    const decoy: Event = { type: 'decoyPlaced', turn: 2, player: 1, cell: 44 };
    for (const e of [ping, move, decoy]) expect(cues([e], 0)).toEqual(['enemy.activity']);
  });

  it('a contact ping and an empty ping differ only after the sweep', () => {
    const hit: Event = { type: 'ping', turn: 1, by: 0, target: 1, center: 44, cells: [44], contact: true };
    const dry: Event = { ...hit, contact: false };
    expect(cues([hit], 0)).toEqual(['ping.send', 'ping.positive']);
    expect(cues([dry], 0)).toEqual(['ping.send', 'ping.negative']);
  });

  it('sinking sounds different depending on whose hull it was', () => {
    const sunk: Event = {
      type: 'fire', turn: 5, by: 0, target: 1, cell: 44, reported: 'SUNK',
      sunkShip: { kind: 'destroyer', cells: [44, 45] },
    };
    expect(cues([sunk], 0)).toContain('fire.sunk.enemy');
    expect(cues([sunk], 1)).toContain('fire.sunk.own');
  });

  it('MELEE: a rival sinking a rival is heard by the third seat', () => {
    // P0 fires on P1; seat 2 is a bystander. Ordinary shells at someone else's board stay
    // silent, but the wreck sounds — it is one fewer fleet between seat 2 and the win.
    const at = (reported: 'HIT' | 'MISS' | 'SUNK'): Event => ({
      type: 'fire', turn: 5, by: 0, target: 1, cell: 44, reported,
      ...(reported === 'SUNK' ? { sunkShip: { kind: 'destroyer' as const, cells: [44, 45] } } : {}),
    });
    const heard = (e: Event, me: PlayerId) => beatsForEvents(redactEventsFor(me, [e]), me).map((b) => b.cue);
    expect(heard(at('HIT'), 2)).toEqual([]);
    expect(heard(at('MISS'), 2)).toEqual([]);
    expect(heard(at('SUNK'), 2)).toEqual(['fire.sunk.enemy']);
    // The two ends of the same shot are unchanged: shooter hears the kill, owner the loss.
    expect(heard(at('SUNK'), 0)).toEqual(['fire.send', 'fire.sunk.enemy']);
    expect(heard(at('SUNK'), 1)).toEqual(['fire.sunk.own']);
  });

  it('a sweep sounds like a sweep, whichever tool asked — and a rival’s ECHO answers you', () => {
    const heard = (e: Event, me: PlayerId) => beatsForEvents(redactEventsFor(me, [e]), me).map((b) => b.cue);
    const scan: Event = { type: 'scan', turn: 2, by: 0, target: 1, cell: 0, cells: [0, 1, 10, 11], contact: true, live: [1] };
    expect(heard(scan, 0)).toEqual(['ping.send', 'ping.positive']);
    // Someone else's SCAN is private, exactly like their ping.
    expect(heard(scan, 2)).toEqual(['enemy.activity']);
    const echo: Event = { type: 'echo', turn: 2, by: 0, target: 1, cells: [0, 1, 10, 11], contact: true, occupancy: 2 };
    expect(heard(echo, 0)).toEqual(['ping.send', 'ping.positive']);
    // The bargain working the other way: a bystander hears the rumble AND the answer.
    expect(heard(echo, 2)).toEqual(['enemy.activity', 'ping.positive']);
    expect(heard({ ...echo, contact: false, occupancy: 0 } as Event, 2)).toEqual(['enemy.activity', 'ping.negative']);
  });

  it("the shooter's own spray is one gun, then a staggered burst of results", () => {
    // Regression: redaction dropped `spray` from the shooter's view, so all four shells
    // played fire.send and landed on the same millisecond.
    const shell = (cell: number): Event =>
      ({ type: 'fire', turn: 3, by: 0, target: 1, cell, reported: 'MISS', spray: true });
    const beats = beatsForEvents(redactEventsFor(0, [shell(0), shell(1), shell(10), shell(11)]), 0);
    expect(beats.filter((b) => b.cue === 'fire.send')).toHaveLength(1);
    const landings = beats.filter((b) => b.cue === 'fire.miss').map((b) => b.at);
    expect(landings).toHaveLength(4);
    expect(new Set(landings).size).toBe(4);
  });

  it('the gun lands before its result', () => {
    const shot: Event = { type: 'fire', turn: 1, by: 0, target: 1, cell: 44, reported: 'MISS' };
    const beats = beatsForEvents(redactEventsFor(0, [shot]), 0);
    expect(beats.map((b) => b.cue)).toEqual(['fire.send', 'fire.miss']);
    expect(beats[1]!.at).toBeGreaterThan(beats[0]!.at);
  });

  it('only the listener hears their own turn boundaries', () => {
    const started: Event = { type: 'turnStarted', turn: 4, player: 1, budget: 5 };
    expect(cues([started], 1)).toEqual(['turn.start']);
    expect(cues([started], 0)).toEqual([]);
  });

  it('every cue a mapping can emit is a declared slot', () => {
    const events: Event[] = [
      { type: 'turnStarted', turn: 1, player: 0, budget: 5 },
      { type: 'fire', turn: 1, by: 0, target: 1, cell: 1, reported: 'HIT' },
      { type: 'fire', turn: 1, by: 0, target: 1, cell: 2, reported: 'MISS' },
      { type: 'fire', turn: 1, by: 0, target: 1, cell: 3, reported: 'SUNK', sunkShip: { kind: 'destroyer' } },
      { type: 'ping', turn: 1, by: 0, target: 1, center: 44, cells: [44], contact: true },
      { type: 'scan', turn: 1, by: 0, target: 1, cell: 0, cells: [0, 1, 10, 11], contact: true, live: [0] },
      { type: 'echo', turn: 1, by: 1, target: 0, cells: [0, 1, 10, 11], contact: false, occupancy: 0 },
      { type: 'move', turn: 1, player: 0, ship: 0, dir: 'N', from: 44, to: 34 },
      { type: 'decoyPlaced', turn: 1, player: 0, cell: 44 },
      { type: 'turnEnded', turn: 1, player: 0, reason: 'pass' },
      { type: 'gameOver', turn: 9, result: 'win', winner: 0 },
    ];
    for (const beat of beatsForEvents(events, 0)) {
      expect(SLOT_IDS).toContain(beat.cue);
    }
  });
});

describe('tool auto-switch and handoff transitions', () => {
  const shot: Event = { type: 'fire', turn: 1, by: 0, target: 1, cell: 44, reported: 'MISS' };
  const flip: Event = { type: 'turnEnded', turn: 1, player: 0, reason: 'pass' };
  const fire = { t: 'ENGINE_ACTION', action: { type: 'FIRE', cell: 44 } } as const;

  const app = (screen: AppState['screen'], events: Event[]): AppState => ({
    screen,
    setup: {} as AppState['setup'],
    // `players` is read for the seat count (redaction needs it to know whether fire is
    // anonymous), so the stub carries two of them.
    session: {
      state: { activePlayer: 0, players: [{}, {}] },
      events,
    } as unknown as AppState['session'],
    pingHues: true,
  });
  const game = (tool: 'FIRE' | 'PING', events: Event[]) =>
    app({ kind: 'game', perspective: 0, tool, selectedShip: null }, events);

  it('the armed tool falling back mid-turn is audible, after the result', () => {
    const beats = beatsForTransition(game('FIRE', []), game('PING', [shot]), fire);
    const auto = beats.find((b) => b.cue === 'tool.autoswitch');
    expect(auto).toBeDefined();
    const result = beats.find((b) => b.cue === 'fire.miss');
    expect(auto!.at).toBeGreaterThan(result!.at);
  });

  it('the turn-flip tool reset stays silent — turn.end narrates that', () => {
    const beats = beatsForTransition(game('PING', []), game('FIRE', [shot, flip]), fire);
    expect(beats.map((b) => b.cue)).not.toContain('tool.autoswitch');
  });

  it('a user tool click is chrome, never the auto-switch cue', () => {
    const beats = beatsForTransition(game('FIRE', []), game('PING', []), { t: 'SET_TOOL', tool: 'PING' });
    expect(beats.map((b) => b.cue)).toContain('ui.toggle');
    expect(beats.map((b) => b.cue)).not.toContain('tool.autoswitch');
  });
});

describe('replay playback audio', () => {
  const replay: Replay = {
    version: 2,
    config: PRESETS.FLOTILLA,
    seed: 42,
    firstPlayer: 0,
    placements: [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)],
    // P0: HIT, ping, HIT (AP exhausts, turn flips) → P1: ping.
    actions: [
      { type: 'FIRE', cell: 40 },
      { type: 'PING', center: 44 },
      { type: 'FIRE', cell: 41 },
      { type: 'PING', center: 0 },
    ],
    digest: '',
  };

  const appAt = (ply: number): AppState => ({
    screen: { kind: 'replay', replay, labels: ['YOU', 'ADMIRAL'], ply, playing: true, speedMs: 300, sonar: [true, true], from: 'menu' },
    setup: {} as AppState['setup'],
    session: null,
    pingHues: true,
  });

  const cuesFor = (from: number, to: number) =>
    beatsForTransition(appAt(from), appAt(to), { t: 'REPLAY_SEEK', ply: to }).map((b) => b.cue);

  it('a one-ply advance replays that ply through live seat-0 ears', () => {
    expect(cuesFor(0, 1)).toEqual(['fire.send', 'fire.hit']);
  });

  it("the opponent's private ping stays redacted to enemy activity", () => {
    expect(cuesFor(3, 4)).toEqual(['enemy.activity']);
  });

  it('jumps and backward steps stay silent', () => {
    expect(cuesFor(0, 2)).toEqual([]);
    expect(cuesFor(2, 1)).toEqual([]);
  });
});

describe('variant rotation', () => {
  it('never plays the same take twice in a row', () => {
    let last = -1;
    const draws = [0.0, 0.9, 0.3, 0.99, 0.5, 0.1, 0.7, 0.44, 0.0, 0.6];
    for (const r of draws) {
      const next = pickVariant(4, last, () => r);
      expect(next).not.toBe(last);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(4);
      last = next;
    }
  });

  it('reaches every take in the slot', () => {
    const seen = new Set<number>();
    let last = -1;
    for (let i = 0; i < 200; i++) {
      last = pickVariant(4, last, () => ((i * 37) % 100) / 100);
      seen.add(last);
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3]));
  });

  it('is a no-op for a single-take slot', () => {
    expect(pickVariant(1, 0, () => 0.99)).toBe(0);
  });

  it('stays in range at the top of the random draw', () => {
    expect(pickVariant(4, -1, () => 0.999999)).toBeLessThan(4);
    expect(pickVariant(4, 2, () => 0.999999)).toBeLessThan(4);
  });
});

describe('repetition ducking', () => {
  it('a rested cue plays at full volume', () => {
    expect(duckRepeat(900)).toBe(1);
    expect(duckRepeat(5000)).toBe(1);
  });

  it('a back-to-back repeat plays at the floor', () => {
    expect(duckRepeat(0)).toBe(0.35);
    expect(duckRepeat(-10)).toBe(0.35);
  });

  it('recovers monotonically between repeats', () => {
    let prev = 0;
    for (const ms of [0, 150, 300, 450, 600, 750, 900]) {
      const f = duckRepeat(ms);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
  });

  it('never silences a cue entirely, however fast the spam', () => {
    expect(duckRepeat(0, 900, 0.35)).toBeGreaterThan(0);
  });
});
