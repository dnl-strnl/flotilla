import { useEffect, useRef } from 'react';
import type { AppState, UIAction } from '../state';
import { beatForRefusal, beatsForTransition } from './cues';
import { initSfx, playBeats, unlockSfx } from './player';

// Board hover = menu hover's tick at under a tenth the level: you sweep a hundred cells
// where you cross two menu buttons.
const BOARD_HOVER_GAIN = 0.075;

// The whole effect layer: wraps dispatch, watches resulting state, plays what cues.ts
// decided. New reasons to make sound belong in cues.ts, not here.
export function useSfx(app: AppState, dispatch: (ui: UIAction) => void): (ui: UIAction) => void {
  const prev = useRef(app);
  const pending = useRef<UIAction | null>(null);

  useEffect(() => {
    void initSfx();
    const unlock = () => unlockSfx();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // Hover is the one cue with no action behind it: one delegated listener,
  // never a handler per button.
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('button, [role="button"]');
      if (!el || (el as HTMLButtonElement).disabled) return;
      // duck: false — sweeping is this cue's job; the gain already covers rapid fire.
      playBeats([{ cue: 'ui.hover', at: 0, gain: el.closest('.board') ? BOARD_HOVER_GAIN : 1, duck: false }]);
    };
    window.addEventListener('pointerover', onOver);
    return () => window.removeEventListener('pointerover', onOver);
  }, []);

  useEffect(() => {
    const ui = pending.current;
    pending.current = null;
    const before = prev.current;
    prev.current = app;
    if (ui) playBeats(beatsForTransition(before, app, ui));
  }, [app]);

  return (ui: UIAction) => {
    const refused = beatForRefusal(prev.current, ui);
    if (refused) playBeats([refused]);
    pending.current = ui;
    dispatch(ui);
  };
}
