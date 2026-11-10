import { useEffect, useState } from 'react';
import { exportReplay, remainingForce, type PlayerId, type Replay } from '../../engine';
import { archiveCount } from '../replayArchive';
import type { Session, UIAction } from '../state';
import { BoardGrid } from '../components/Board';
import { truthBoardCells } from '../viewmodels';

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function sideAccuracy(session: Session, seat: PlayerId) {
  let shots = 0;
  let reported = 0;
  let real = 0;
  for (const e of session.events) {
    if (e.type === 'fire' && e.by === seat) {
      shots++;
      if (e.reported !== 'MISS') reported++;
      if (e.hitShip) real++;
    }
  }
  return { shots, reported, real };
}

export function sessionReplay(session: Session): Replay {
  const phase = session.state.phase;
  const forfeitBy =
    phase.kind === 'won' && phase.byForfeit ? ((phase.winner === 0 ? 1 : 0) as 0 | 1) : undefined;
  return exportReplay(
    session.config,
    session.setup.seed,
    session.state.firstPlayer,
    session.placements,
    session.actions,
    session.events,
    forfeitBy,
  );
}

export function exportSessionReplay(session: Session): void {
  downloadJson(`flotilla-replay-${session.setup.seed}.json`, sessionReplay(session));
}

// The seat that fired the shell which emptied `eliminated` (sinkings are public).
export function eliminatorOf(session: Session, eliminated: PlayerId): PlayerId | null {
  for (let i = session.state.shots.length - 1; i >= 0; i--) {
    const shot = session.state.shots[i]!;
    if (shot.target === eliminated && shot.result === 'SUNK') return shot.by;
  }
  return null;
}

// Final true force for every seat, strongest first, winner breaking a tie. Display only:
// the game is decided by who is last afloat.
export function finalForce(session: Session, winner: PlayerId | null) {
  return session.state.players
    .map((player, seat) => ({ seat, ...remainingForce(player) }))
    .sort(
      (a, b) =>
        b.squares - a.squares ||
        b.ships - a.ships ||
        Number(b.seat === winner) - Number(a.seat === winner) ||
        a.seat - b.seat,
    );
}

export function GameOver(props: { session: Session; dispatch: (a: UIAction) => void }) {
  const { session, dispatch } = props;
  const { state } = session;
  const nameFor = (seat: PlayerId) => (session.bots[seat] ? session.bots[seat]!.toUpperCase() : 'YOU');
  // Read-only archive count; the write happens in App's edge effect, not here.
  const [archived, setArchived] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void archiveCount().then((n) => live && setArchived(n));
    return () => {
      live = false;
    };
  }, [session]);

  const phase = state.phase;
  // MELEE third ending: the human went down while survivors play on, so no winner yet.
  const knockedOut = phase.kind === 'playing';
  const mySeat = session.bots.indexOf(null) as PlayerId;
  const verdict = knockedOut
    ? 'DEFEAT'
    : phase.kind === 'draw'
      ? 'DRAW — TURN CAP REACHED'
      : `${session.bots[phase.winner] === null ? 'VICTORY' : `${nameFor(phase.winner)} WINS`}${phase.byForfeit ? ' BY FORFEIT' : ''}`;

  const winner = phase.kind === 'won' ? phase.winner : null;
  const killer = knockedOut && mySeat >= 0 ? eliminatorOf(session, mySeat) : null;
  // Standings table only with three fleets; in a duel the verdict says it all.
  const standings = state.players.length > 2;

  return (
    <div className="gameover-screen">
      <div className="gameover-head">
        <div className="micro-label">
          {knockedOut ? 'YOU ARE OUT OF THE ENGAGEMENT' : 'ENGAGEMENT CONCLUDED'} · T{state.turn}
        </div>
        <h2 className={phase.kind === 'draw' ? '' : 'accent'}>{verdict}</h2>
        {knockedOut && (
          <div className="micro-label">
            {killer !== null ? `SUNK BY ${nameFor(killer)}` : 'LAST HULL DOWN'} · THE SURVIVORS
            FIGHT ON WITHOUT YOU
          </div>
        )}
      </div>

      {standings && (
        <div className="standings gameover-standings">
          <div className="micro-label">
            {knockedOut ? 'WHERE IT STOOD' : 'FINAL STANDINGS'} — TRUE HULL
          </div>
          {finalForce(session, winner).map((row, rank) => (
            <div
              key={row.seat}
              className={`standing-row${row.seat === winner ? ' mine' : ''}${
                row.ships === 0 ? ' out' : ''
              }`}
            >
              <span className="standing-rank">{row.ships === 0 ? '—' : rank + 1}</span>
              <span className="standing-name">{nameFor(row.seat)}</span>
              <span className="standing-force">{row.squares} SQ</span>
              <span className="standing-ships">
                {row.ships} SHIP{row.ships === 1 ? '' : 'S'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="gameover-boards">
        {state.players.map((_, seat) => {
          const acc = sideAccuracy(session, seat);
          return (
            <div key={seat} className="gameover-board">
              <BoardGrid title={`${nameFor(seat)} — FINAL DISPOSITION`} cells={truthBoardCells(state.players[seat]!)} />
              <div className="stat-row">
                <span className="micro-label">SHOTS {acc.shots}</span>
                <span className="micro-label">
                  ACCURACY {acc.shots ? `${((acc.real / acc.shots) * 100).toFixed(0)}%` : '—'}
                </span>
                <span className="micro-label">
                  BELIEVED {acc.shots ? `${((acc.reported / acc.shots) * 100).toFixed(0)}%` : '—'}
                  {acc.reported !== acc.real ? ' (DECEIVED)' : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {archived !== null && archived > 0 && (
        <div className="micro-label gameover-archive">
          ARCHIVED · {archived} GAME{archived === 1 ? '' : 'S'} IN LOCAL CORPUS
        </div>
      )}

      <div className="gameover-actions">
        <button type="button" className="btn-primary" onClick={() => dispatch({ t: 'REMATCH' })}>
          REMATCH
        </button>
        <button
          type="button"
          className="btn-choice"
          onClick={() =>
            dispatch({
              t: 'OPEN_REPLAY',
              replay: sessionReplay(session),
              labels: session.state.players.map((_, i) => nameFor(i)),
              from: 'gameover',
            })
          }
        >
          VIEW REPLAY
        </button>
        <button type="button" className="btn-choice" onClick={() => exportSessionReplay(session)}>
          EXPORT REPLAY JSON
        </button>
        <button type="button" className="btn-choice" onClick={() => dispatch({ t: 'TO_MENU' })}>
          MAIN MENU
        </button>
      </div>
    </div>
  );
}
