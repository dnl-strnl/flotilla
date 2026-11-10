import { describe, expect, it } from 'vitest';
import { aggregateMelee } from '../src/sim/stats';
import { emptySide } from '../src/sim/run';
import type { MeleeRecord } from '../src/sim/melee';

// A record with only the fields the aggregation reads.
function rec(over: Partial<MeleeRecord>): MeleeRecord {
  return {
    seed: 1,
    seatOf: [0, 1, 2],
    winnerSeat: null,
    victimSeat: null,
    firstBloodVictim: null,
    turns: 50,
    damage: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    shotsAt: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    shotsAtWeakest: [0, 0, 0],
    shotsWithStrictWeakest: [0, 0, 0],
    // No seat ever lost a ship unless a case says so.
    lowWater: [5, 5, 5],
    bySeat: [emptySide(), emptySide(), emptySide()],
    ...over,
  };
}

describe('melee aggregation', () => {
  it('credits wins to the BOT, not the seat it happened to hold', () => {
    const m = aggregateMelee(
      [
        // Bot 2 sits in seat 0 and wins.
        rec({ seatOf: [2, 0, 1], winnerSeat: 0, victimSeat: 1 }),
        // Bot 2 sits in seat 1 and wins again.
        rec({ seatOf: [1, 2, 0], winnerSeat: 1, victimSeat: 2 }),
      ],
      3,
    );
    expect(m.byBot[2]!.wins).toBe(2);
    expect(m.byBot[0]!.wins).toBe(0);
    // Seat shares stay separate — that is the opening-bias probe.
    expect(m.bySeat[0]!.wins).toBe(1);
    expect(m.bySeat[1]!.wins).toBe(1);
    expect(m.decided).toBe(2);
  });

  it("measures kill-steal as the winner's share of damage on the dead fleet", () => {
    // Seat 0 wins; the victim (seat 2) took 2 hits from the winner and 8 from seat 1 —
    // a textbook snipe, and the index should say so.
    const stolen = rec({
      winnerSeat: 0,
      victimSeat: 2,
      damage: [
        [0, 0, 2],
        [0, 0, 8],
        [0, 0, 0],
      ],
    });
    expect(aggregateMelee([stolen], 3).killSteal).toBeCloseTo(0.2, 6);

    // The same game where the winner did all the work.
    const earned = rec({
      winnerSeat: 0,
      victimSeat: 2,
      damage: [
        [0, 0, 10],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(aggregateMelee([earned], 3).killSteal).toBeCloseTo(1, 6);
  });

  it('measures snowball as P(first fleet hit is the fleet that dies)', () => {
    const records = [
      rec({ winnerSeat: 0, victimSeat: 2, firstBloodVictim: 2 }), // snowballed
      rec({ winnerSeat: 0, victimSeat: 2, firstBloodVictim: 1 }), // recovered
      rec({ winnerSeat: 1, victimSeat: 0, firstBloodVictim: 1 }), // first blood went on to win
    ];
    const m = aggregateMelee(records, 3);
    expect(m.snowballToVictim).toBeCloseTo(1 / 3, 6);
    expect(m.firstBloodWins).toBeCloseTo(1 / 3, 6);
  });

  it('flags a bot whose whole interval clears an even split', () => {
    const wins = Array.from({ length: 60 }, () => rec({ winnerSeat: 0, victimSeat: 1 }));
    const m = aggregateMelee(wins, 3);
    expect(m.byBot[0]!.share).toBe(1);
    expect(m.flags.some((f) => f.startsWith('DOMINANT'))).toBe(true);
  });

  it('counts undecided games as draws and flags them', () => {
    const m = aggregateMelee([rec({}), rec({ winnerSeat: 1, victimSeat: 0 })], 3);
    expect(m.draws).toBe(1);
    expect(m.flags.some((f) => f.startsWith('DRAWS'))).toBe(true);
  });
});

describe('melee gang-up measures', () => {
  it('scores focus against the fair share, and flags a dogpile', () => {
    // Both shooters sent 8 of 10 shells at whoever was weakest at the time.
    const piled = rec({
      shotsAtWeakest: [8, 8, 0],
      shotsWithStrictWeakest: [10, 10, 0],
    });
    const m = aggregateMelee([piled], 3);
    expect(m.focusIndex).toBeCloseTo(0.8, 6);
    expect(m.flags.some((f) => f.startsWith('GANG-UP'))).toBe(true);

    // A field that splits its fire sits at the fair 50% and earns no flag.
    const fair = aggregateMelee(
      [rec({ shotsAtWeakest: [5, 5, 0], shotsWithStrictWeakest: [10, 10, 0] })],
      3,
    );
    expect(fair.focusIndex).toBeCloseTo(0.5, 6);
    expect(fair.flags.some((f) => f.startsWith('GANG-UP'))).toBe(false);
  });

  it('ignores shells fired while no fleet was strictly weakest', () => {
    // Every shell landed in a tie, so there is nothing to measure — not a zero.
    const m = aggregateMelee([rec({ shotsAtWeakest: [0, 0, 0], shotsWithStrictWeakest: [0, 0, 0] })], 3);
    expect(m.focusIndex).toBe(0);
    expect(m.flags.some((f) => f.startsWith('GANG-UP'))).toBe(false);
  });

  it('calls a fleet double-teamed only when BOTH opponents pressed it', () => {
    // Seat 2 dies having taken most of seat 0's AND seat 1's shells.
    const ganged = rec({
      winnerSeat: 0,
      victimSeat: 2,
      shotsAt: [
        [0, 2, 8],
        [2, 0, 8],
        [5, 5, 0],
      ],
    });
    // Same death, but seat 1 spent its game shooting at seat 0 instead.
    const duel = rec({
      winnerSeat: 0,
      victimSeat: 2,
      shotsAt: [
        [0, 2, 8],
        [8, 0, 2],
        [5, 5, 0],
      ],
    });
    expect(aggregateMelee([ganged], 3).doubleTeamRate).toBeCloseTo(1, 6);
    expect(aggregateMelee([duel], 3).doubleTeamRate).toBeCloseTo(0, 6);
    expect(aggregateMelee([ganged, duel], 3).doubleTeamRate).toBeCloseTo(0.5, 6);
  });

  it('reads win rate against the fewest ships a seat was ever reduced to', () => {
    const m = aggregateMelee(
      [
        // Seat 0 wins untouched; seat 1 is ground to 2 ships; seat 2 dies.
        rec({ winnerSeat: 0, victimSeat: 2, lowWater: [5, 2, 0] }),
        // Seat 1 wins after being ground to 2 ships — the comeback.
        rec({ winnerSeat: 1, victimSeat: 0, lowWater: [0, 2, 5] }),
      ],
      3,
    );
    // Two seats bottomed out at 2 ships; one of them went on to win.
    expect(m.comebackByLowWater[2]).toBeCloseTo(0.5, 6);
    // Untouched fleets won both times they appeared; wiped ones never do.
    expect(m.comebackByLowWater[5]).toBeCloseTo(0.5, 6);
    expect(m.comebackByLowWater[0]).toBe(0);
    // Nothing ever bottomed out at 1 or 3 — not measured rather than zero.
    expect(m.comebackByLowWater[1]).toBeNull();
    expect(m.comebackByLowWater[3]).toBeNull();
  });
});
