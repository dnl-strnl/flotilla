import { useMemo } from 'react';
import { replayFrames, type Event } from '../../engine';
import type { Screen, UIAction } from '../state';
import { BoardGrid } from '../components/Board';
import { EventLog } from '../components/panels';
import { logLinesTruth } from '../format';
import { truthBoardWithSonar } from '../viewmodels';

// Cells each board spotlights for the current ply's events: the shot or ping sweep lands on
// the defender's board, a move or decoy on the actor's own.
function focusCells(events: Event[], seats: number): Set<number>[] {
  const focus: Set<number>[] = Array.from({ length: seats }, () => new Set<number>());
  for (const e of events) {
    switch (e.type) {
      case 'fire':
        focus[e.target]?.add(e.cell);
        break;
      case 'ping':
        for (const cell of e.cells) focus[e.target]?.add(cell);
        break;
      case 'move':
        focus[e.player]?.add(e.from);
        focus[e.player]?.add(e.to);
        break;
      case 'decoyPlaced':
      case 'decoySpent':
        focus[e.player]?.add(e.cell);
        break;
      default:
        break;
    }
  }
  return focus;
}

// Post-game scrubber: the engagement re-run ply by ply in full truth, deceptions exposed.
export function Replay(props: {
  screen: Extract<Screen, { kind: 'replay' }>;
  pingHues: boolean;
  dispatch: (a: UIAction) => void;
}) {
  const { screen, pingHues, dispatch } = props;
  const frames = useMemo(() => replayFrames(screen.replay), [screen.replay]);
  const last = frames.length - 1;
  const ply = Math.min(screen.ply, last);
  const frame = frames[ply]!;
  const { state } = frame;

  const seek = (p: number) => dispatch({ t: 'REPLAY_SEEK', ply: p });
  // A ply opens a turn iff its events carry that turn's turnStarted.
  const opensTurn = (p: number) => frames[p]!.events.some((e) => e.type === 'turnStarted');
  const nextTurn = () => {
    for (let p = ply + 1; p <= last; p++) if (opensTurn(p)) return seek(p);
    seek(last);
  };
  const prevTurn = () => {
    for (let p = ply - 1; p > 0; p--) if (opensTurn(p)) return seek(p);
    seek(0);
  };

  const lines = useMemo(
    () => logLinesTruth(frames.slice(0, ply + 1).flatMap((f) => f.events)),
    [frames, ply],
  );
  const caption = logLinesTruth(frame.events);
  const focus = focusCells(frame.events, state.players.length);

  const status =
    state.phase.kind === 'won'
      ? `${screen.labels[state.phase.winner]} WINS`
      : state.phase.kind === 'draw'
        ? 'DRAW'
        : `${screen.labels[state.activePlayer]} ACTING · AP ${state.ap}/${state.budget}`;

  return (
    <div className="spectate-screen">
      <header className="game-header">
        <span className="wordmark-small">FLOTILLA</span>
        <span className="header-stat">BATTLE REPLAY · FULL TRUTH</span>
        <span className="header-stat header-turn">T{state.turn}</span>
        <span className={`header-stat${state.phase.kind !== 'playing' ? ' accent' : ''}`}>{status}</span>
        <span className="header-spacer" />
        {screen.replay.config.pings && (
          <>
            <span className="micro-label">SONAR</span>
            {state.players.map((_, p) => (
              <button
                key={p}
                type="button"
                className={`btn-micro${screen.sonar[p] ? ' selected' : ''}`}
                title={`Show ${screen.labels[p] ?? `P${p + 1}`}'s sonar intel, drawn over the boards they swept.`}
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
              {/* Figure space pads ON to OFF's width so the toggle doesn't shove its row. */}
              PING HEATMAP {pingHues ? 'ON ' : 'OFF'}
            </button>
          </>
        )}
        <span className="micro-label">PACE</span>
        {([800, 300, 80] as const).map((ms) => (
          <button
            key={ms}
            type="button"
            className={`btn-micro${screen.speedMs === ms ? ' selected' : ''}`}
            onClick={() => dispatch({ t: 'REPLAY_SET_SPEED', speedMs: ms })}
          >
            {ms === 800 ? 'SLOW' : ms === 300 ? 'NORM' : 'FAST'}
          </button>
        ))}
        <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'CLOSE_REPLAY' })}>
          CLOSE
        </button>
      </header>

      <div className="replay-scrub">
        <button type="button" className="btn-micro" title="jump to deployment" onClick={() => seek(0)}>
          ⏮
        </button>
        <button type="button" className="btn-micro" title="previous turn" onClick={prevTurn}>
          ◂◂
        </button>
        <button type="button" className="btn-micro" title="previous action [←]" onClick={() => seek(ply - 1)}>
          ◂
        </button>
        <button
          type="button"
          className="btn-micro replay-play"
          title="play / pause [space]"
          onClick={() => dispatch({ t: 'REPLAY_TOGGLE_PLAY' })}
        >
          {screen.playing ? '❚❚' : '▶'}
        </button>
        <button type="button" className="btn-micro" title="next action [→]" onClick={() => seek(ply + 1)}>
          ▸
        </button>
        <button type="button" className="btn-micro" title="next turn" onClick={nextTurn}>
          ▸▸
        </button>
        <button type="button" className="btn-micro" title="jump to end" onClick={() => seek(last)}>
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={ply}
          aria-label="replay position"
          onChange={(e) => seek(Number(e.currentTarget.value))}
        />
        {/* Padded to the final ply's digit count so the slider keeps its width while playing. */}
        <span className="micro-label">
          {String(ply).padStart(String(last).length, ' ')}/{last}
        </span>
      </div>

      <div className="replay-caption">
        {ply === 0 ? (
          <span className="replay-caption-line tone-neutral">
            <span className="log-text">DEPLOYMENT — SCRUB OR PRESS PLAY TO RUN THE ENGAGEMENT</span>
          </span>
        ) : (
          caption.map((line) => (
            <span key={line.key} className={`replay-caption-line tone-${line.tone}`}>
              <span className="log-text">{line.text}</span>
            </span>
          ))
        )}
      </div>

      <div className={`spectate-columns${state.players.length > 2 ? ' wide' : ''}`}>
        {state.players.map((_, seat) => (
          <BoardGrid
            key={seat}
            title={`${screen.labels[seat] ?? `P${seat + 1}`} — TRUTH`}
            // Each board carries every OTHER seat's sonar; the toggles pick whose.
            cells={truthBoardWithSonar(state, seat, pingHues, screen.sonar)}
            preview={focus[seat]}
          />
        ))}
        <aside className="col-log">
          <EventLog lines={lines} />
        </aside>
      </div>
    </div>
  );
}
