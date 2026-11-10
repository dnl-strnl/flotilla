import { useMemo } from 'react';
import { MODE_LABEL, type Screen, type Session, type UIAction } from '../state';
import { BoardGrid } from '../components/Board';
import { EventLog } from '../components/panels';
import { logLinesTruth } from '../format';
import { truthBoardWithSonar } from '../viewmodels';
import { exportSessionReplay, sessionReplay } from './GameOver';

// CPU vs CPU observation deck: boards in full truth with opponents' sonar, adjustable pace.
export function Spectate(props: {
  session: Session;
  screen: Extract<Screen, { kind: 'spectate' }>;
  pingHues: boolean;
  dispatch: (a: UIAction) => void;
}) {
  const { session, screen, pingHues, dispatch } = props;
  const { state } = session;
  const over = state.phase.kind !== 'playing';
  const lines = useMemo(() => logLinesTruth(session.events), [session.events]);

  return (
    <div className="spectate-screen">
      <header className="game-header">
        <span className="wordmark-small">FLOTILLA</span>
        <span className="header-stat">OBSERVATION DECK</span>
        <span className="header-stat">
          {session.setup.preset} · {MODE_LABEL[session.setup.mode]}
        </span>
        <span className="header-stat">T{state.turn}</span>
        <span className={`header-stat${over ? ' accent' : ''}`}>
          {over
            ? state.phase.kind === 'won'
              ? `${session.bots[state.phase.winner]?.toUpperCase()} (P${state.phase.winner + 1}) WINS`
              : 'DRAW'
            : `P${state.activePlayer + 1} ${session.bots[state.activePlayer]?.toUpperCase()} ACTING`}
        </span>
        <span className="header-spacer" />
        {session.config.pings && (
          <>
            <span className="micro-label">SONAR</span>
            {state.players.map((_, p) => (
              <button
                key={p}
                type="button"
                className={`btn-micro${screen.sonar[p] ? ' selected' : ''}`}
                title={`Show P${p + 1}'s sonar intel, drawn over the boards they swept. Turn the others off to see only what P${p + 1} knew.`}
                onClick={() => dispatch({ t: 'TOGGLE_SONAR', player: p })}
              >
                P{p + 1}
              </button>
            ))}
            <button
              type="button"
              className="btn-micro"
              title="Ping washes shift red → blue as the intel ages"
              onClick={() => dispatch({ t: 'TOGGLE_PING_HUES' })}
            >
              PING HEATMAP {pingHues ? 'ON' : 'OFF'}
            </button>
          </>
        )}
        {!over && (
          <>
            <span className="micro-label">PACE</span>
            {([800, 300, 80] as const).map((ms) => (
              <button
                key={ms}
                type="button"
                className={`btn-micro${screen.speedMs === ms ? ' selected' : ''}`}
                onClick={() => dispatch({ t: 'SET_SPEED', speedMs: ms })}
              >
                {ms === 800 ? 'SLOW' : ms === 300 ? 'NORM' : 'FAST'}
              </button>
            ))}
            <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'TOGGLE_PAUSE' })}>
              {screen.paused ? '▶ RESUME' : '❚❚ HOLD'}
            </button>
          </>
        )}
        {over && (
          <>
            <button
              type="button"
              className="btn-micro"
              onClick={() =>
                dispatch({
                  t: 'OPEN_REPLAY',
                  replay: sessionReplay(session),
                  labels: session.bots.map((b, i) => `P${i + 1} · ${b?.toUpperCase() ?? 'HUMAN'}`),
                  from: 'spectate',
                })
              }
            >
              REPLAY
            </button>
            <button type="button" className="btn-micro" onClick={() => exportSessionReplay(session)}>
              EXPORT REPLAY
            </button>
            <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'REMATCH' })}>
              RE-RUN
            </button>
          </>
        )}
        <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'TO_MENU' })}>
          EXIT
        </button>
      </header>

      <div className={`spectate-columns${state.players.length > 2 ? ' wide' : ''}`}>
        {state.players.map((_, seat) => (
          <BoardGrid
            key={seat}
            title={`P${seat + 1} · ${session.bots[seat]?.toUpperCase() ?? 'HUMAN'} — TRUTH`}
            // Each board carries every OTHER seat's sonar; the toggles pick whose.
            cells={truthBoardWithSonar(state, seat, pingHues, screen.sonar)}
          />
        ))}
        <aside className="col-log">
          <EventLog lines={lines} />
        </aside>
      </div>
    </div>
  );
}
