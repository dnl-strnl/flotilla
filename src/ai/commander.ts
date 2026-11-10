import { AP_COST, encodeAction, rngInt } from '../engine';
import type { Action } from '../engine';
import { buildBelief, gatherIntel, hottestCell } from './montecarlo';
import type { Bot } from './types';

// COMMANDER — Bayesian heatmap via MC fleet sampling. Deliberately blind to Flotilla
// dynamics (no staleness, no pings, shots only). Once every cell is resolved without a win,
// a ship must have slid behind a final MISS, so it probes random MISS cells.
export function makeCommander(samples = 1000): Bot {
  return (obs, legal, rng) => {
    if (obs.ap < AP_COST.FIRE) return { type: 'PASS' };

    const belief = buildBelief(
      obs,
      { samples, missDecayTurns: null, usePings: false, maxAttempts: 12 },
      rng,
    );
    const intel = gatherIntel(obs);
    // Never re-shoot a resolved cell — until the whole board is resolved.
    const exclude = new Set(intel.shotCells);
    let cell = hottestCell(belief.heat, exclude, rng);
    if (cell === null) {
      cell =
        intel.misses.length > 0
          ? intel.misses[rngInt(rng, intel.misses.length)]!.cell
          : hottestCell(belief.heat, new Set(), rng);
    }
    if (cell === null) return { type: 'PASS' };

    const action: Action = { type: 'FIRE', cell };
    return legal.includes(encodeAction(action)) ? action : { type: 'PASS' };
  };
}
