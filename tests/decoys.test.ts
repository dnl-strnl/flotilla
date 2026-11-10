import { describe, expect, it } from 'vitest';
import { DECOY_BASE, PRESETS, encodeAction, legalActionIds } from '../src/engine';
import { decoy, doStep, newGame, pass, ping, run, shot, shotsBy, sunkBy } from './helpers';

const decoyIds = (ids: number[]) => ids.filter((id) => id >= DECOY_BASE && id < DECOY_BASE + 100);

describe('decoy lifecycle', () => {
  // P1 parks a decoy at 35 (r3c5) — the 3×3 around it contains no real ships.
  const withDecoy = () => run(newGame(PRESETS.FLOTILLA), [pass, decoy(35), pass]);

  it('answers every ping as a ship while alive', () => {
    const r = run(withDecoy().state, [ping(35), ping(35)]);
    expect(r.state.players[0].pings.map((p) => p.contact)).toEqual([true, true]);
  });

  it('absorbs one fake HIT, then dies silently: later shots MISS, later pings are clean', () => {
    const base = withDecoy().state;
    const r = run(base, [shot(35), ping(35)]);
    // Attacker was told HIT; their intel records a plain HIT.
    expect(shotsBy(r.state, 0)[0]).toMatchObject({ cell: 35, result: 'HIT' });
    expect(shotsBy(r.state, 0)[0]!.sunkShip).toBeUndefined();
    // But the decoy is spent and the region now pings clean.
    expect(r.state.players[1].decoys[0]).toMatchObject({ cell: 35, spent: true });
    expect(r.state.players[0].pings[0]).toMatchObject({ contact: false });
    // A later shot at the same cell is a MISS — HIT then MISS, no explanation.
    const r2 = run(r.state, [pass, pass, shot(35)]);
    const records = shotsBy(r2.state, 0).filter((s) => s.cell === 35);
    expect(records.map((s) => s.result)).toEqual(['HIT', 'MISS']);
  });

  it('a fake hit never sinks, never pins, and never changes budgets', () => {
    const base = withDecoy().state;
    const r = run(base, [shot(35), pass]); // P0 "hits", then P1's turn starts
    expect(sunkBy(r.state, 0)).toEqual([]);
    expect(r.state.players[1].ships.every((s) => s.hits.every((h) => !h))).toBe(true);
    const started = r.events.filter((e) => e.type === 'turnStarted').pop();
    expect(started).toMatchObject({ player: 1, budget: 5 }); // still 5 ships
  });

  it('caps placements at 2 per game, counting spent decoys', () => {
    // P1 places two decoys across two turns; thereafter DECOY is masked out forever.
    const r = run(newGame(PRESETS.FLOTILLA), [pass, decoy(35), pass, pass, decoy(37), pass, pass]);
    expect(r.state.activePlayer).toBe(1);
    expect(r.state.ap).toBe(5);
    expect(decoyIds(legalActionIds(r.state))).toEqual([]);
  });

  it('cannot be placed on own ships or alive decoys, but can sit on an enemy miss marker', () => {
    // P0 misses at P1's cell 55; P1 may still decoy there.
    const r = run(newGame(PRESETS.FLOTILLA), [shot(55), pass]);
    const ids = decoyIds(legalActionIds(r.state));
    expect(ids).toContain(DECOY_BASE + 55);
    expect(ids).not.toContain(DECOY_BASE + 0); // own carrier cell
    const withOne = doStep(r.state, decoy(55));
    expect(decoyIds(legalActionIds(withOne.state))).not.toContain(DECOY_BASE + 55);
  });

  it('blocks own ship movement while alive, frees the cell once spent', () => {
    // P0's destroyer sits at 80,81; P0 decoys its own cell 82 (due east).
    const east = encodeAction({ type: 'MOVE', ship: 4, dir: 'E' });
    const s1 = run(newGame(PRESETS.FLOTILLA), [decoy(82)]).state;
    expect(legalActionIds(s1)).not.toContain(east);
    // P1 shoots 82 on P0's board → fake HIT consumes the decoy…
    const s2 = run(s1, [pass, shot(82), pass]).state;
    expect(s2.players[0].decoys[0]!.spent).toBe(true);
    // …and the destroyer can now slide into the vacated cell.
    expect(legalActionIds(s2)).toContain(east);
  });
});
