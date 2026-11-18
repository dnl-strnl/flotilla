import { useEffect, useReducer, useRef, useState } from 'react';
import {
  END_TURN_KEY,
  PING_HUES_LS_KEY,
  TOOL_KEY,
  TOOL_ORDER,
  initialState,
  reducer,
  type UIAction,
} from './state';
import { cpuDelayMs } from './pacing';
import { archiveGame, saveGameToDisk, type ArchivedGame } from './replayArchive';
import { sessionReplay } from './screens/GameOver';
import { SfxControl } from './sfx/SfxControl';
import { ScreenshotControl } from './components/ScreenshotControl';
import { useSfx } from './sfx/useSfx';
import { playBeats, startMusic, stopMusic } from './sfx/player';
import { FLEET } from '../engine';
import { Title } from './screens/Title';
import { Menu } from './screens/Menu';
import { Placement } from './screens/Placement';
import { Game } from './screens/Game';
import { GameOver } from './screens/GameOver';
import { Spectate } from './screens/Spectate';
import { Replay } from './screens/Replay';

// How long the screen takes to sink to black before a battle begins.
const DEPART_MS = 4000;
// After the black lifts, how long the CPU holds its first move so the board can be taken in.
const SETTLE_MS = 3500;

export default function App() {
  const [app, rawDispatch] = useReducer(reducer, initialState);
  // Sound is a wrapper around dispatch, never a participant in it: the hook
  // watches the states the reducer produces and plays what cues.ts decided.
  const sfxDispatch = useSfx(app, rawDispatch);
  const [titled, setTitled] = useState(false);

  // Departure: the press that actually begins a battle (CONFIRM DEPLOYMENT, or OBSERVE
  // when no one is playing) is held back while the screen sinks to black, then lifts
  // on the game.
  const [veil, setVeil] = useState<'fall' | 'lift' | null>(null);
  const departure = useRef(0);
  const [settling, setSettling] = useState(false);
  useEffect(() => () => window.clearTimeout(departure.current), []);
  const dispatch = (ui: UIAction) => {
    const begins =
      (ui.t === 'START_SETUP' && !ui.setup.human) ||
      (ui.t === 'CONFIRM_PLACEMENT' &&
        app.screen.kind === 'placement' &&
        app.screen.working.length === FLEET.length);
    if (!begins) return sfxDispatch(ui);
    if (veil) return;
    setVeil('fall');
    playBeats([{ cue: 'game.depart', at: 0, reverb: true }]);
    departure.current = window.setTimeout(() => {
      sfxDispatch(ui);
      setVeil('lift');
      setSettling(true);
      departure.current = window.setTimeout(() => setSettling(false), SETTLE_MS);
    }, DEPART_MS);
  };

  // The theme runs under the title card, the menu and fleet placement, and stops on
  // the departure press.
  // Not when framed: an embedded preview of the game should stay silent.
  const themed =
    (app.screen.kind === 'menu' || app.screen.kind === 'placement') && !veil && window.self === window.top;
  useEffect(() => {
    if (!themed) return;
    startMusic('/audio/title.ogg');
    return () => stopMusic();
  }, [themed]);

  // CPU playback driver. Timing ONLY — every decision happens inside the
  // reducer via the engine. One micro-action per tick, skippable elsewhere.
  useEffect(() => {
    const session = app.session;
    if (!session || session.state.phase.kind !== 'playing') return;
    if (session.bots[session.state.activePlayer] === null) return;
    if (app.screen.kind === 'spectate' && app.screen.paused) return;
    if (app.screen.kind !== 'game' && app.screen.kind !== 'spectate') return;
    if (settling) return;
    const base = app.screen.kind === 'spectate' ? app.screen.speedMs : 400;
    // Human→CPU handoff: the flip at the tail ended a human turn (flips always
    // push turnEnded then turnStarted adjacently — see engine/step.ts endTurn).
    const [prev, last] = session.events.slice(-2);
    const handoff =
      last?.type === 'turnStarted' &&
      prev?.type === 'turnEnded' &&
      session.bots[prev.player] === null;
    const delay = cpuDelayMs(base, session.events, Math.random, handoff);
    const id = window.setTimeout(() => dispatch({ t: 'CPU_STEP' }), delay);
    return () => window.clearTimeout(id);
  }, [app, settling]);

  // Replay playback driver. Same shape as the CPU driver above: timing only,
  // every cursor change goes through the reducer.
  useEffect(() => {
    const screen = app.screen;
    if (screen.kind !== 'replay' || !screen.playing) return;
    const id = window.setTimeout(() => dispatch({ t: 'REPLAY_SEEK', ply: screen.ply + 1 }), screen.speedMs);
    return () => window.clearTimeout(id);
  }, [app]);

  // Archive every finished game (edge effect). The ref key (seed, action count, outcome)
  // stops re-renders double-writing, while a new game on a replayed seed still writes.
  const archived = useRef<string | null>(null);
  useEffect(() => {
    const session = app.session;
    if (!session) return;
    const phase = session.state.phase;
    if (phase.kind === 'playing') return;
    const key = `${session.setup.seed}|${session.actions.length}|${phase.kind}|${phase.kind === 'won' ? phase.winner : ''}`;
    if (archived.current === key) return;
    archived.current = key;

    const humanSeat = session.bots[0] === null ? 0 : session.bots[1] === null ? 1 : null;
    const winner = phase.kind === 'won' ? phase.winner : null;
    const outcome =
      humanSeat === null
        ? phase.kind === 'draw'
          ? ('bot-draw' as const)
          : ('bot-win' as const)
        : phase.kind === 'draw'
          ? ('draw' as const)
          : winner === humanSeat
            ? ('win' as const)
            : ('loss' as const);

    const record: ArchivedGame = {
      savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      appVersion: __APP_VERSION__,
      preset: session.setup.preset,
      bots: session.bots,
      humanSeat,
      outcome,
      winner,
      byForfeit: phase.kind === 'won' && phase.byForfeit === true,
      turns: session.state.turn,
      seed: session.setup.seed,
      actionCount: session.actions.length,
      replay: sessionReplay(session),
    };
    void archiveGame(record);
    void saveGameToDisk(record);
  }, [app.session]);

  // Persist the ping-hue display preference (write-at-the-edge, like sfx).
  useEffect(() => {
    localStorage.setItem(PING_HUES_LS_KEY, app.pingHues ? '1' : '0');
  }, [app.pingHues]);

  // Keyboard: 1–8 arm an action, 9 or Enter ends the turn, Q/E/Tab cycle actions,
  // R rotate, Esc cancel. Keys come from TOOL_KEY and the reducer drops unusable tools,
  // so the keys mirror the action-bar buttons exactly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || veil === 'fall') return;
      const screen = app.screen;
      if (screen.kind === 'placement') {
        if (e.key === 'r' || e.key === 'R') dispatch({ t: 'ROTATE' });
        else if (e.key === 'Escape') dispatch({ t: 'UNDO_PLACE' });
        else if (e.key === 'Enter') dispatch({ t: 'CONFIRM_PLACEMENT' });
        return;
      }
      if (screen.kind === 'replay') {
        if (e.key === 'ArrowRight') dispatch({ t: 'REPLAY_SEEK', ply: screen.ply + 1 });
        else if (e.key === 'ArrowLeft') dispatch({ t: 'REPLAY_SEEK', ply: screen.ply - 1 });
        else if (e.key === ' ') {
          e.preventDefault(); // keep the page from scrolling
          dispatch({ t: 'REPLAY_TOGGLE_PLAY' });
        } else if (e.key === 'Escape') dispatch({ t: 'CLOSE_REPLAY' });
        return;
      }
      if (screen.kind === 'game') {
        if (e.key === 'Tab') {
          e.preventDefault(); // in-game Tab cycles tools, not focus
          dispatch({ t: 'CYCLE_TOOL', delta: e.shiftKey ? -1 : 1 });
        } else if (e.key === 'e' || e.key === 'E') dispatch({ t: 'CYCLE_TOOL', delta: 1 });
        else if (e.key === 'q' || e.key === 'Q') dispatch({ t: 'CYCLE_TOOL', delta: -1 });
        else if (e.key === 'Escape') dispatch({ t: 'SET_TOOL', tool: 'FIRE' });
        else if (e.key === 'Enter' || e.key === END_TURN_KEY)
          dispatch({ t: 'ENGINE_ACTION', action: { type: 'PASS' } });
        else {
          const armed = TOOL_ORDER.find((tool) => TOOL_KEY[tool] === e.key);
          if (armed) dispatch({ t: 'SET_TOOL', tool: armed });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app.screen, veil]);

  const screen = () => {
    switch (app.screen.kind) {
      case 'menu':
        return titled ? <Menu dispatch={dispatch} /> : <Title onStart={() => setTitled(true)} />;
      case 'placement':
        return <Placement screen={app.screen} dispatch={dispatch} />;
      case 'game':
        return app.session ? (
          <Game session={app.session} screen={app.screen} pingHues={app.pingHues} dispatch={dispatch} />
        ) : null;
      case 'gameover':
        return app.session ? <GameOver session={app.session} dispatch={dispatch} /> : null;
      case 'spectate':
        return app.session ? (
          <Spectate session={app.session} screen={app.screen} pingHues={app.pingHues} dispatch={dispatch} />
        ) : null;
      case 'replay':
        return <Replay screen={app.screen} pingHues={app.pingHues} dispatch={dispatch} />;
    }
  };

  return (
    <>
      {screen()}
      <SfxControl />
      <ScreenshotControl />
      {veil && (
        <div
          className={`depart-veil depart-veil--${veil}`}
          style={{ animationDuration: veil === 'fall' ? `${DEPART_MS}ms` : undefined }}
          onAnimationEnd={() => veil === 'lift' && setVeil(null)}
        />
      )}
    </>
  );
}
