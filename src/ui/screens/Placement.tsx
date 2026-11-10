import { useState } from 'react';
import { FLEET, canPlace, cellsFor, fitsOnBoard } from '../../engine';
import type { Screen, UIAction } from '../state';
import { BoardGrid, type CellView } from '../components/Board';
import { SHIP_LABEL } from '../format';

export function Placement(props: {
  screen: Extract<Screen, { kind: 'placement' }>;
  dispatch: (a: UIAction) => void;
}) {
  const { screen, dispatch } = props;
  const [hover, setHover] = useState<number | null>(null);

  const placedCells = screen.working.flatMap((p) =>
    cellsFor(p.origin, p.orient, FLEET.find((f) => f.kind === p.kind)!.length),
  );
  const next = FLEET[screen.working.length];

  const cells: CellView[] = Array.from({ length: 100 }, () => ({}));
  screen.working.forEach((p) => {
    const len = FLEET.find((f) => f.kind === p.kind)!.length;
    for (const c of cellsFor(p.origin, p.orient, len)) {
      cells[c] = { classes: 'own-ship', title: SHIP_LABEL[p.kind] };
    }
  });
  if (screen.rejected !== null) {
    const view = cells[screen.rejected]!;
    cells[screen.rejected] = { ...view, classes: `${view.classes ?? ''} rejected`.trim() };
  }

  let preview: Set<number> | undefined;
  let previewInvalid = false;
  if (next && hover !== null) {
    const ghost = fitsOnBoard(hover, screen.orient, next.length)
      ? cellsFor(hover, screen.orient, next.length)
      : [hover];
    preview = new Set(ghost);
    previewInvalid = !canPlace(hover, screen.orient, next.length, placedCells);
  }

  return (
    <div className="placement-screen">
      <div className="placement-main">
        <BoardGrid
          title="FLEET DEPLOYMENT — COMMANDER"
          cells={cells}
          preview={preview}
          previewInvalid={previewInvalid}
          onCellClick={(cell) => dispatch({ t: 'PLACE_AT', cell })}
          onCellHover={setHover}
        />
      </div>
      <div className="placement-side">
        <div className="micro-label">DEPLOYMENT QUEUE</div>
        <div className="deploy-queue">
          {FLEET.map((spec, i) => (
            <div
              key={spec.kind}
              className={`fleet-row${i < screen.working.length ? ' placed' : i === screen.working.length ? ' active' : ''}`}
            >
              <span className="fleet-name">{SHIP_LABEL[spec.kind]}</span>
              <span className="fleet-blocks">
                {Array.from({ length: spec.length }, (_, b) => (
                  <span key={b} className="dmg-block" />
                ))}
              </span>
              <span className="fleet-state">
                {i < screen.working.length ? 'SET' : i === screen.working.length ? '◂ PLACING' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="placement-controls">
          <button type="button" className="btn-choice" onClick={() => dispatch({ t: 'ROTATE' })}>
            ROTATE [R] — {screen.orient === 'H' ? 'HORIZONTAL' : 'VERTICAL'}
          </button>
          <button type="button" className="btn-choice" onClick={() => dispatch({ t: 'RANDOMIZE_PLACEMENT' })}>
            RANDOMIZE
          </button>
          <button
            type="button"
            className="btn-choice"
            disabled={screen.working.length === 0}
            onClick={() => dispatch({ t: 'UNDO_PLACE' })}
          >
            UNDO
          </button>
          <button
            type="button"
            className="btn-choice"
            disabled={screen.working.length === 0}
            onClick={() => dispatch({ t: 'CLEAR_PLACEMENT' })}
          >
            CLEAR
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={screen.working.length !== FLEET.length}
            onClick={() => dispatch({ t: 'CONFIRM_PLACEMENT' })}
          >
            CONFIRM DEPLOYMENT
          </button>
          <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'TO_MENU' })}>
            ← ABORT TO MENU
          </button>
        </div>
      </div>
    </div>
  );
}
