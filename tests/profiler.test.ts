import { describe, expect, it } from 'vitest';
import { PRESETS, type Observation, type Ship, type ShotRecord } from '../src/engine';
import { LIEUTENANT_TUNING, apForensics, profileOpponent } from '../src/ai/lieutenant';

const ship = (origin: number): Ship => ({
  kind: 'destroyer', length: 2, origin, orient: 'H', hits: [false, false], sunk: false,
});

function obsWith(extra: Partial<Observation>): Observation {
  return {
    config: PRESETS.FLOTILLA,
    me: 0,
    turn: 41,
    ap: 4,
    budget: 4,
    movedShips: [],
    myShips: [ship(0)],
    myDecoys: [],
    myDecoysLeft: 2,
    shotsAgainstMe: [],
    myShots: [],
    myPings: [],
    enemyWakes: [],
    enemySunk: [],
    enemyShipsRemaining: 5,
    ...extra,
  } as Observation;
}

// We decide on turn 41 (odd), so their turns are every even turn 2..40 — and
// the forensics look at ALL of them, so test data must cover every one or the
// uncovered turns read (correctly) as turns they spent on something unseen.
const THEIR_TURNS = Array.from({ length: 20 }, (_, i) => (i + 1) * 2);
const theirTurns = (n = THEIR_TURNS.length) => THEIR_TURNS.slice(0, n);

describe('LIEUTENANT opponent profiling', () => {
  it('counts a turn as slack only when a MOVE could have been afforded', () => {
    // 5 hulls => 5 AP. Two shots = 4 AP, leaving 1: not enough for a 2-AP move.
    const maxRate = theirTurns().flatMap((t) => [
      { cell: 10, turn: t },
      { cell: 11, turn: t },
    ]);
    expect(apForensics(obsWith({ shotsAgainstMe: maxRate }), 2).slackTurns).toBe(0);

    // One shot a turn leaves 3 AP unexplained — every turn is a slack turn.
    const oneShot = theirTurns().map((t) => ({ cell: 10, turn: t }));
    const f = apForensics(obsWith({ shotsAgainstMe: oneShot }), 2);
    expect(f.slackTurns).toBe(f.turns);
  });

  it('tracks their shrinking budget as we sink their hulls', () => {
    // After 3 of their hulls are sunk their budget is 2 AP: one shot a turn is
    // then the maximum rate, so those turns are NOT slack.
    const sunk: ShotRecord[] = [
      { cell: 1, result: 'SUNK', turn: 2, sunkShip: 'destroyer' },
      { cell: 2, result: 'SUNK', turn: 4, sunkShip: 'submarine' },
      { cell: 3, result: 'SUNK', turn: 6, sunkShip: 'cruiser' },
    ];
    const oneShot = theirTurns().filter((t) => t > 6).map((t) => ({ cell: 10, turn: t }));
    const f = apForensics(obsWith({ myShots: sunk, shotsAgainstMe: oneShot, enemyShipsRemaining: 2 }), 2);
    // Only the early turns (budget 5..3, one shot) count as slack.
    expect(f.slackTurns).toBeLessThan(f.turns);
    expect(f.slackTurns).toBeGreaterThan(0);
  });

  it('reads a pure shooter as STATIC and anything with spare AP as DODGER', () => {
    const maxRate = theirTurns().flatMap((t) => [
      { cell: 10, turn: t },
      { cell: 11, turn: t },
    ]);
    expect(profileOpponent(obsWith({ shotsAgainstMe: maxRate }), LIEUTENANT_TUNING).read).toBe('STATIC');

    const withSlack = [...maxRate.filter((s) => s.turn !== 20)];
    expect(profileOpponent(obsWith({ shotsAgainstMe: withSlack }), LIEUTENANT_TUNING).read).toBe('DODGER');
  });

  it('never claims STATIC when the ruleset has no movement to rule out', () => {
    const p = profileOpponent(obsWith({ config: { ...PRESETS.CLASSIC } }), LIEUTENANT_TUNING);
    expect(p.dodging).toBe(false);
    expect(p.read).toBe('STATIC');
  });

  it('a lockout overrides the static read', () => {
    const maxRate = theirTurns().flatMap((t) => [
      { cell: 10, turn: t },
      { cell: 11, turn: t },
    ]);
    expect(profileOpponent(obsWith({ shotsAgainstMe: maxRate }), LIEUTENANT_TUNING, true).read).toBe('DODGER');
  });
});
