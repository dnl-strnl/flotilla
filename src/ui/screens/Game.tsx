import { useMemo, useRef, useState } from 'react';
import {
  MOVE_BASE,
  MOVE_DIRS,
  encodeAction,
  intelAlive,
  legalActionIds,
  movedOrigin,
  observe,
  blockCells,
  blockFits,
  pingCells,
  SCAN_SIZE,
  ECHO_SIZE,
  sprayCells,
  sprayFits,
  shipCells,
  type Action,
  type MoveDir,
} from '../../engine';
import { MODE_LABEL, type Screen, type Session, type UIAction } from '../state';
import { BoardGrid } from '../components/Board';
import { APBar, ActionBar, EventLog, FleetStatus, RulesPanel } from '../components/panels';
import { logLinesFor } from '../format';
import { enemyBoardCells, ownBoardCells } from '../viewmodels';

// After a spend auto-switches the armed tool (FIRE→PING on 1 AP), swallow enemy-board
// clicks briefly: a quick second click aimed with the old tool must not spend the new one.
const AUTOSWITCH_GUARD_MS = 200;

export function Game(props: {
  session: Session;
  screen: Extract<Screen, { kind: 'game' }>;
  pingHues: boolean;
  dispatch: (a: UIAction) => void;
}) {
  const { session, screen, pingHues, dispatch } = props;
  const { state } = session;
  const p = screen.perspective;
  // Enemy hover carries its board, or a sweep preview would paint onto every enemy grid.
  const [enemyHover, setEnemyHover] = useState<{ seat: number; cell: number } | null>(null);

  const obs = useMemo(() => observe(state, p), [state, p]);
  const playing = state.phase.kind === 'playing';
  const myTurn = playing && state.activePlayer === p && session.bots[p] === null;
  const cpuTurn = playing && session.bots[state.activePlayer] !== null;
  const legal = useMemo(() => (myTurn ? legalActionIds(state) : []), [state, myTurn]);
  const logLines = useMemo(() => logLinesFor(p, session.events), [p, session.events]);

  // My most recent shell this turn, per target board.
  const lastShotAt = useMemo(() => {
    const out = new Map<number, number>();
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]!;
      if (e.type === 'fire' && e.by === p && !out.has(e.target)) out.set(e.target, e.cell);
      if (e.type === 'turnStarted' && e.player === p) break;
    }
    return out;
  }, [session.events, p]);

  const tryAction = (action: Action) => {
    if (legal.includes(encodeAction(action))) dispatch({ t: 'ENGINE_ACTION', action });
  };

  // An auto-switch = screen.tool changed while the action log grew. Guard clock lives at
  // the edge; idempotent render-time ref write, so StrictMode double-render is safe.
  const guard = useRef({ actions: session.actions.length, tool: screen.tool, until: 0 });
  if (guard.current.actions !== session.actions.length || guard.current.tool !== screen.tool) {
    if (myTurn && session.actions.length > guard.current.actions && screen.tool !== guard.current.tool) {
      guard.current.until = performance.now() + AUTOSWITCH_GUARD_MS;
    }
    guard.current.actions = session.actions.length;
    guard.current.tool = screen.tool;
  }

  // The clicked board IS the target. `at` = relative seat offset; 1 is left implicit.
  const onEnemyCell = (cell: number, at: number) => {
    if (!myTurn) return;
    if (performance.now() < guard.current.until) return;
    const aim = at === 1 ? {} : { at };
    if (screen.tool === 'FIRE') tryAction({ type: 'FIRE', cell, ...aim });
    else if (screen.tool === 'PING') tryAction({ type: 'PING', center: cell, ...aim });
    // The clicked cell is the block's TOP-LEFT corner; off-board blocks are not legal.
    else if (screen.tool === 'SPRAY') tryAction({ type: 'SPRAY', cell, ...aim });
    else if (screen.tool === 'SCAN') tryAction({ type: 'SCAN', cell, ...aim });
    else if (screen.tool === 'ECHO') tryAction({ type: 'ECHO', cell, ...aim });
    // FORK hits every enemy grid, so clicking either board fires the same action.
    else if (screen.tool === 'FORK') tryAction({ type: 'FORK', cell });
  };

  // One entry per enemy board, nearest seat first. A destroyed fleet keeps its board (seats
  // never renumber) but can no longer be aimed at.
  const enemies = obs.intel
    .map((intel, seat) => ({ intel, seat }))
    .filter((e) => e.intel !== null && e.seat !== p)
    .map(({ intel, seat }) => ({
      seat,
      at: (seat - p + obs.playerCount) % obs.playerCount,
      intel: intel!,
      alive: intelAlive(intel!),
      label: session.concealed ? null : (session.bots[seat]?.toUpperCase() ?? `PLAYER ${seat + 1}`),
    }));

  // Move click-targets: each NEWLY occupied cell → the move landing there (unambiguous).
  // Legality comes from `legal` only.
  const destinationsFor = (shipIndex: number): Map<number, MoveDir> => {
    const out = new Map<number, MoveDir>();
    const ship = obs.myShips[shipIndex];
    if (!ship) return out;
    const current = new Set(shipCells(ship));
    MOVE_DIRS.forEach((dir, dirIndex) => {
      if (!legal.includes(MOVE_BASE + shipIndex * 4 + dirIndex)) return;
      const dest = movedOrigin(ship, dir);
      if (dest === null) return;
      for (const cell of shipCells({ ...ship, origin: dest })) {
        if (!current.has(cell) && !out.has(cell)) out.set(cell, dir);
      }
    });
    return out;
  };

  const movableShipAt = (cell: number): number | null => {
    const idx = obs.myShips.findIndex((ship) => shipCells(ship).includes(cell));
    if (idx < 0) return null;
    return destinationsFor(idx).size > 0 ? idx : null;
  };

  const selected = screen.tool === 'MOVE' ? screen.selectedShip : null;
  const moveDests =
    selected !== null ? destinationsFor(selected) : new Map<number, MoveDir>();

  const onOwnCell = (cell: number) => {
    if (!myTurn) return;
    if (screen.tool === 'DECOY') {
      tryAction({ type: 'DECOY', cell });
      return;
    }
    if (screen.tool !== 'MOVE') return;
    // Armed ship + click on one of its destinations → commit the move.
    const dir = moveDests.get(cell);
    if (selected !== null && dir) {
      tryAction({ type: 'MOVE', ship: selected, dir });
      dispatch({ t: 'SELECT_SHIP', ship: null });
      return;
    }
    // Otherwise clicking a movable ship arms it; anything else disarms.
    dispatch({ t: 'SELECT_SHIP', ship: movableShipAt(cell) });
  };

  // The sweep or spray footprint, shown only on the board actually under the cursor.
  const previewFor = (seat: number) => {
    if (!myTurn || enemyHover === null) return undefined;
    if (screen.tool === 'FORK') return new Set([enemyHover.cell]);
    if (enemyHover.seat !== seat) return undefined;
    if (screen.tool === 'PING') return new Set(pingCells(enemyHover.cell));
    if (screen.tool === 'SPRAY' && sprayFits(enemyHover.cell)) return new Set(sprayCells(enemyHover.cell));
    if (screen.tool === 'SCAN' && blockFits(enemyHover.cell, SCAN_SIZE)) {
      return new Set(blockCells(enemyHover.cell, SCAN_SIZE));
    }
    if (screen.tool === 'ECHO' && blockFits(enemyHover.cell, ECHO_SIZE)) {
      return new Set(blockCells(enemyHover.cell, ECHO_SIZE));
    }
    return undefined;
  };

  const ownCells = ownBoardCells(obs);
  if (myTurn && screen.tool === 'MOVE') {
    if (selected !== null) {
      for (const cell of shipCells(obs.myShips[selected]!)) {
        ownCells[cell] = {
          ...ownCells[cell]!,
          classes: `${ownCells[cell]!.classes ?? ''} move-selected`.trim(),
        };
      }
    } else {
      // Nothing armed yet: hint which ships can actually move this turn.
      obs.myShips.forEach((ship, idx) => {
        if (destinationsFor(idx).size === 0) return;
        for (const cell of shipCells(ship)) {
          ownCells[cell] = {
            ...ownCells[cell]!,
            classes: `${ownCells[cell]!.classes ?? ''} move-ready`.trim(),
          };
        }
      });
    }
  }

  const melee = obs.playerCount > 2;
  // Name whoever actually holds the turn; with one opponent that is simply the other seat.
  const actingSeat = melee ? state.activePlayer : p === 0 ? 1 : 0;
  // A concealed lineup is named by seat only: reading the rank should cost attention.
  const opponentLabel = session.concealed
    ? `P${actingSeat + 1}`
    : (session.bots[actingSeat]?.toUpperCase() ?? `PLAYER ${actingSeat + 1}`);

  return (
    <div className="game-screen">
      <header className="game-header">
        <span className="wordmark-small">FLOTILLA</span>
        <span className="header-stat">
          {session.setup.preset} · {MODE_LABEL[session.setup.mode]}
        </span>
        <span className="header-stat">T{state.turn}</span>
        <span className={`header-stat ${myTurn ? 'accent' : ''}`}>
          {playing ? (myTurn ? 'YOUR TURN' : cpuTurn ? `${opponentLabel} ACTING…` : 'STANDBY') : 'ENGAGEMENT OVER'}
        </span>
        {cpuTurn && (
          <button type="button" className="btn-micro" onClick={() => dispatch({ t: 'CPU_FINISH_TURN' })}>
            SKIP PLAYBACK ≫
          </button>
        )}
        <span className="header-spacer" />
        <RulesPanel config={session.config} seats={obs.playerCount} />
        {session.config.pings && (
          <button
            type="button"
            className="btn-micro"
            title="Ping washes shift red → blue as the intel ages"
            onClick={() => dispatch({ t: 'TOGGLE_PING_HUES' })}
          >
            PING HEATMAP {pingHues ? 'ON' : 'OFF'}
          </button>
        )}
        {/* No concede in MELEE: the engine refuses it (no single "other player"). */}
        {playing && session.bots[p] === null && !melee && (
          <button
            type="button"
            className="btn-micro"
            title="Concede: counts as a defeat, reveals the enemy fleet, replay saveable"
            onClick={() => {
              if (window.confirm('Strike your colors? This ends the engagement as a defeat.')) {
                dispatch({ t: 'FORFEIT' });
              }
            }}
          >
            FORFEIT
          </button>
        )}
        <button
          type="button"
          className="btn-micro"
          title="Quit to the main menu — nothing is recorded"
          onClick={() => dispatch({ t: 'TO_MENU' })}
        >
          ABANDON
        </button>
      </header>

      <div className={`game-columns${melee ? ' game-columns--melee' : ''}`}>
        <section className="col-own">
          <BoardGrid
            title="FLEET GRID"
            cells={ownCells}
            onCellClick={onOwnCell}
            preview={selected !== null ? new Set(moveDests.keys()) : undefined}
            targeting={myTurn && (screen.tool === 'DECOY' || screen.tool === 'MOVE')}
            dimmed={!myTurn && playing}
          />
          <APBar ap={myTurn ? state.ap : 0} budget={myTurn ? state.budget : 0} />
          <FleetStatus
            obs={obs}
            legal={legal}
            showMoveControls={obs.config.movement}
            onMove={(ship, dir) => tryAction({ type: 'MOVE', ship, dir })}
          />
        </section>

        <section className={`col-enemy${melee ? ' col-enemy--melee' : ''}`}>
          <div className="enemy-boards">
            {enemies.map((enemy) => (
              <BoardGrid
                key={enemy.seat}
                title={
                  melee
                    ? `${enemy.alive ? 'ENEMY GRID' : 'DESTROYED'} · P${enemy.seat + 1}${
                        enemy.label ? ` ${enemy.label}` : ''
                      }`
                    : 'ENEMY GRID'
                }
                cells={enemyBoardCells(
                  {
                    turn: obs.turn,
                    me: obs.me,
                    playerCount: obs.playerCount,
                    myShots: enemy.intel.shots,
                    myPings: enemy.intel.pings,
                    enemyWakes: enemy.intel.wakes,
                  },
                  lastShotAt.get(enemy.seat) ?? null,
                  pingHues,
                )}
                onCellClick={enemy.alive ? (cell) => onEnemyCell(cell, enemy.at) : undefined}
                onCellHover={
                  enemy.alive
                    ? (cell) => setEnemyHover(cell === null ? null : { seat: enemy.seat, cell })
                    : undefined
                }
                preview={enemy.alive ? previewFor(enemy.seat) : undefined}
                targeting={
                  enemy.alive && myTurn && screen.tool !== 'DECOY' && screen.tool !== 'MOVE'
                }
                dimmed={!myTurn && playing}
                wrecked={!enemy.alive}
              />
            ))}
          </div>
          <ActionBar
            obs={obs}
            legal={legal}
            tool={screen.tool}
            myTurn={myTurn}
            onTool={(tool) => dispatch({ t: 'SET_TOOL', tool })}
            onEndTurn={() => tryAction({ type: 'PASS' })}
          />
        </section>

        <aside className="col-log">
          <EventLog lines={logLines} />
        </aside>
      </div>
    </div>
  );
}
