import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESETS, createGame, legalActionIds, observe, type PresetName } from '../src/engine';
import { ActionBar } from '../src/ui/components/panels';
import { TEST_FLEET } from './helpers';

// The action bar shows only what the ruleset has. CLASSIC and SALVO are FIRE and PASS alone,
// on one row, at any fleet count; the special-tool row exists only in three-fleet FLOTILLA.

// Each action-bar row as the list of button names on it.
function rows(preset: PresetName, fleets: number): string[][] {
  const state = createGame(
    PRESETS[preset],
    Array.from({ length: fleets }, () => structuredClone(TEST_FLEET)) as [typeof TEST_FLEET, typeof TEST_FLEET],
    7,
  );
  const html = renderToStaticMarkup(
    createElement(ActionBar, {
      obs: observe(state, state.activePlayer),
      legal: legalActionIds(state),
      tool: 'FIRE',
      myTurn: true,
      onTool: () => {},
      onEndTurn: () => {},
    }),
  );
  return html
    .split('class="action-bar')
    .slice(1)
    .map((row) => [...row.matchAll(/action-name">([A-Z]+)</g)].map((m) => m[1]!));
}

describe('the action bar', () => {
  for (const preset of ['CLASSIC', 'SALVO'] as const) {
    for (const fleets of [2, 3]) {
      it(`${preset} ${fleets}P is FIRE and PASS side by side, nothing else`, () => {
        expect(rows(preset, fleets)).toEqual([['FIRE', 'PASS']]);
      });
    }
  }

  it('FLOTILLA 2P keeps PASS on its own row under the core four', () => {
    expect(rows('FLOTILLA', 2)).toEqual([['FIRE', 'PING', 'MOVE', 'DECOY'], ['PASS']]);
  });

  it('FLOTILLA 3P adds the special-tool row', () => {
    const r = rows('FLOTILLA', 3);
    expect(r).toHaveLength(3);
    expect(r[1]).toHaveLength(4);
    expect(r[2]).toEqual(['PASS']);
  });
});
