import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  createGame,
  legalActionIds,
  mulberry32,
  observe,
  step,
  type Action,
  type GameState,
} from '../src/engine';
import { makeMelee } from '../src/ai';
import { TEST_FLEET } from './helpers';

// ADMIRAL's whole-turn plans in MELEE: a SCAN is bought for the shells that follow it,
// so the turn that sweeps must also shoot what the sweep found.

const rng = mulberry32(5);
const fleet = () => structuredClone(TEST_FLEET);

// Seat 2, its locker armed (12 hull cells off, carrier and battleship sunk), on its own turn.
function ready(): GameState {
  let s = createGame(PRESETS.FLOTILLA, [fleet(), fleet(), fleet()], 7);
  s = structuredClone(s);
  let left = 12;
  for (const ship of s.players[2]!.ships) {
    for (let i = 0; i < ship.hits.length && left > 0; i++) {
      if (!ship.hits[i]) {
        ship.hits[i] = true;
        left--;
      }
    }
    ship.sunk = ship.hits.every(Boolean);
  }
  while (s.activePlayer !== 2) s = step(s, { type: 'PASS' }, rng).state;
  return s;
}

describe('ADMIRAL turn plans', () => {
  // Seat 0's carrier lies along row 0, so the 2×2 at 0 answers on 0 and 1.
  const scanned = () => step(ready(), { type: 'SCAN', cell: 0, at: 1 }, rng).state;
  const admiral = makeMelee('admiral', { samples: 50 });
  // Offset 1 from seat 2 is seat 0; a canonical shot leaves `at` off.
  const onSeat0 = (action: Action) => action.type === 'FIRE' && (action.at ?? 1) === 1;

  it('spends the shell its 4 AP leaves on a cell its SCAN marked live', () => {
    const s = scanned();
    const action = admiral(observe(s, 2), legalActionIds(s), rng);
    expect(onSeat0(action)).toBe(true);
    expect([0, 1]).toContain((action as { cell: number }).cell);
  });

  it('shoots both live cells when the budget runs to two shells', () => {
    // A final-duel budget, written in directly: 5 AP buys the SCAN and both shells.
    let s = scanned();
    s.ap += 1;
    const fired: number[] = [];
    for (let i = 0; i < 2; i++) {
      const action = admiral(observe(s, 2), legalActionIds(s), rng);
      expect(onSeat0(action)).toBe(true);
      fired.push((action as { cell: number }).cell);
      s = step(s, action, rng).state;
    }
    expect(fired.sort()).toEqual([0, 1]);
  });
});
