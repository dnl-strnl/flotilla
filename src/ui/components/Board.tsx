import type { ReactNode } from 'react';
import { BOARD_SIZE, toCell } from '../../engine';

export interface CellView {
  // Space-separated modifier classes appended to "cell".
  classes?: string;
  glyph?: ReactNode;
  // Small tag rendered in the cell corner (e.g. ping age).
  tag?: string;
  title?: string;
  // 0..1 opacity for the ping wash.
  pingOpacity?: number;
  // Wash color encoding intel age: red (fresh) → blue (cold).
  pingColor?: string;
}

export function BoardGrid(props: {
  title: string;
  cells: CellView[];
  onCellClick?: (cell: number) => void;
  onCellHover?: (cell: number | null) => void;
  // Cells highlighted by the current hover preview (e.g. ping 3×3, ship ghost).
  preview?: Set<number>;
  previewInvalid?: boolean;
  targeting?: boolean;
  dimmed?: boolean;
  // This fleet is gone: grey the grid out so it no longer reads as a target.
  wrecked?: boolean;
}) {
  const { cells, onCellClick, onCellHover, preview } = props;
  const rows = Array.from({ length: BOARD_SIZE }, (_, r) => r);
  const cols = Array.from({ length: BOARD_SIZE }, (_, c) => c);
  return (
    <div
      className={`board${props.targeting ? ' board-targeting' : ''}${
        props.dimmed ? ' board-dimmed' : ''
      }${props.wrecked ? ' board-wrecked' : ''}`}
    >
      <div className="board-title">{props.title}</div>
      <div
        className="board-grid"
        onMouseLeave={onCellHover ? () => onCellHover(null) : undefined}
      >
        <div className="gutter corner" />
        {cols.map((c) => (
          <div key={`c${c}`} className="gutter">{c + 1}</div>
        ))}
        {rows.map((r) => (
          <div key={`r${r}`} className="board-row">
            <div className="gutter">{String.fromCharCode(65 + r)}</div>
            {cols.map((c) => {
              const idx = toCell(r, c);
              const view = cells[idx] ?? {};
              const inPreview = preview?.has(idx);
              const cls = [
                'cell',
                view.classes ?? '',
                inPreview ? (props.previewInvalid ? 'cell-preview-bad' : 'cell-preview') : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={idx}
                  type="button"
                  className={cls}
                  title={view.title}
                  tabIndex={-1}
                  onClick={onCellClick ? () => onCellClick(idx) : undefined}
                  onMouseEnter={onCellHover ? () => onCellHover(idx) : undefined}
                >
                  {view.pingOpacity !== undefined && (
                    <span
                      className="ping-wash"
                      style={{ opacity: view.pingOpacity, background: view.pingColor }}
                    />
                  )}
                  {view.glyph && <span className="cell-glyph">{view.glyph}</span>}
                  {view.tag && <span className="cell-tag">{view.tag}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
