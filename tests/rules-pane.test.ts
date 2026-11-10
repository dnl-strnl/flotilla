import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOOLS, toolCost, type PresetName, type ToolId } from '../src/engine';
import { RulesPane } from '../src/ui/components/RulesPane';

// The rules pane is the only place the special tools are written down for a player, and
// their AP costs are DERIVED from the TOOLS array. Render it and read the numbers back, so
// repricing a tool cannot quietly leave the pane lying.

const render = (mode: 'duel' | 'open', flavorRoll = 0, preset: PresetName = 'FLOTILLA') =>
  renderToStaticMarkup(
    createElement(RulesPane, {
      mode,
      preset,
      flavorRoll,
      onClose: () => {},
    }),
  );

const SPECIALS: ToolId[] = ['SPRAY', 'SCAN', 'FORK', 'ECHO'];

describe('the rules pane action table', () => {
  it('lists every special tool in MELEE, with its real price', () => {
    const html = render('open');
    for (const tool of SPECIALS) {
      expect(html).toContain(`>${tool}</span>`);
      expect(html).toContain(`>${toolCost(tool)} AP</span>`);
    }
    // One gate, stated once, not four thresholds scattered down the rows.
    expect(html).toContain('lose your first ship');
    expect(html).not.toContain('hull cells');
    // Nothing is missing: the table covers the whole TOOLS array, not a hand-picked subset.
    expect(new Set(SPECIALS)).toEqual(new Set(TOOLS.map((t) => t.id)));
  });

  it('promises no special tools in a duel, where none exist', () => {
    const html = render('duel');
    for (const tool of SPECIALS) expect(html).not.toContain(`>${tool}</span>`);
    // The core four are still there.
    for (const core of ['FIRE', 'PING', 'MOVE', 'DECOY', 'PASS']) {
      expect(html).toContain(`>${core}</span>`);
    }
  });

  it('promises no special tools or melee AP rules in three-fleet CLASSIC and SALVO', () => {
    for (const preset of ['CLASSIC', 'SALVO'] as const) {
      const html = render('open', 0, preset);
      for (const tool of SPECIALS) expect(html).not.toContain(`>${tool}</span>`);
      expect(html).not.toContain('two survivors');
      expect(html).toContain(`Everything in ${preset} holds`);
    }
  });

  it('names the preset SALVO, not SPRAY — that name belongs to a tool now', () => {
    const html = render('duel');
    expect(html).toContain('SALVO');
  });

  it('states the melee AP floor and the full-AP final duel only where they apply', () => {
    expect(render('open')).toContain('two survivors fight every remaining turn at full');
    expect(render('duel')).not.toContain('two survivors');
  });

  it('MELEE shows only the delta: no restated objective or core actions', () => {
    const html = render('open');
    expect(html).not.toContain('OBJECTIVE');
    for (const core of ['FIRE', 'PING', 'MOVE', 'DECOY', 'PASS']) {
      expect(html).not.toContain(`>${core}</span>`);
    }
  });

  it('draws a different MELEE flavor line across the roll range', () => {
    const lines = new Set([0, 0.2, 0.4, 0.6, 0.8, 0.999].map((r) => render('open', r)));
    expect(lines.size).toBe(5);
  });
});
