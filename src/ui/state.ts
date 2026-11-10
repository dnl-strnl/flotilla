import {
  FLEET,
  PRESETS,
  TOOLS,
  canPlace,
  cellsFor,
  createGame,
  decodeAction,
  encodeAction,
  forfeit,
  isDead,
  legalActionIds,
  mulberry32,
  observe,
  randomFleet,
  step,
  type Action,
  type Cell,
  type Event,
  type GameConfig,
  type GameState,
  type Orient,
  type PlayerId,
  type PresetName,
  type Replay,
  type ToolId,
  type ShipPlacement,
  type AtLeastTwo,
} from '../engine';
import { makeBot, makeMelee, type Bot, type BotName } from '../ai';

// One reducer, one state. All game mutations flow through ENGINE_ACTION/CPU_STEP (engine
// step() + log append). Rendering is pure; timing lives in App's driver.

// MODE is the fleet count ('duel' 1v1, 'open' 1v1v1); ROLE (`human`) is orthogonal: hold a
// fleet, or hand every seat to a CPU and watch.
export type Mode = 'duel' | 'open';

// Fleets on the water. The human, when playing, holds one of them.
export function fleetsFor(mode: Mode): 2 | 3 {
  return mode === 'open' ? 3 : 2;
}

// Display names for the fleet-count pick, in one place.
export const MODE_LABEL: Record<Mode, string> = { duel: 'DUEL', open: 'MELEE' };

export interface Setup {
  mode: Mode;
  preset: PresetName;
  // CPU bots in seat order, filling whatever seats the human does not. The tail goes
  // unused when the mode seats fewer than three fleets.
  cpuA: BotName;
  cpuB: BotName;
  cpuC: BotName;
  // ROLE: hold a fleet yourself, or hand every seat to a CPU and watch.
  human: boolean;
  seed: number;
}

export interface Session {
  setup: Setup;
  config: GameConfig;
  placements: AtLeastTwo<ShipPlacement[]>;
  state: GameState;
  // Full micro-action history (replay export).
  actions: Action[];
  // Full-truth event history (replay export; redact per side for display).
  events: Event[];
  // Bot name per seat; null = human.
  bots: (BotName | null)[];
  // True when the seat->rank map was shuffled at launch and must stay off the in-game HUD.
  concealed: boolean;
}

export type CoreTool = 'FIRE' | 'PING' | 'DECOY' | 'MOVE';
export type Tool = CoreTool | ToolId;

// The four every fleet always has, and the four MELEE specials that unlock with
// damage. The split drives the two-row action bar as well as the hotkeys.
export const CORE_TOOLS: CoreTool[] = ['FIRE', 'PING', 'MOVE', 'DECOY'];

// Row order for the specials, not TOOLS' unlock order: FORK and ECHO only matter with a
// third fleet, so they sit last. A tool added to TOOLS must declare its slot here.
const SPECIAL_RANK: Record<ToolId, number> = { SPRAY: 0, SCAN: 1, FORK: 2, ECHO: 3 };
export const SPECIAL_TOOLS: ToolId[] = TOOLS.map((t) => t.id).sort(
  (a, b) => SPECIAL_RANK[a] - SPECIAL_RANK[b],
);

// Action-bar order: the core four on hotkeys 1–4, then the specials on 5–8 left to
// right. Q/E/Tab cycle whatever is usable.
export const TOOL_ORDER: Tool[] = [...CORE_TOOLS, ...SPECIAL_TOOLS];
export const TOOL_KEY: Record<Tool, string> = {
  FIRE: '1',
  PING: '2',
  MOVE: '3',
  DECOY: '4',
  SPRAY: '5',
  SCAN: '6',
  FORK: '7',
  ECHO: '8',
};

// End turn sits past the widest action bar, so the key never moves when a ruleset hides
// PING/MOVE/DECOY or a duel hides the specials. Enter does the same thing.
export const END_TURN_KEY = '9';

export type Screen =
  | { kind: 'menu' }
  | {
      kind: 'placement';
      working: ShipPlacement[];
      orient: Orient;
      // Cell of the last rejected placement attempt (for the flash).
      rejected: Cell | null;
    }
  | {
      kind: 'game';
      perspective: PlayerId;
      tool: Tool;
      // Ship index armed for a MOVE; its legal destinations become clickable.
      selectedShip: number | null;
    }
  | { kind: 'gameover' }
  | {
      kind: 'spectate';
      speedMs: number;
      paused: boolean;
      // Per player: draw their sonar intel over the opponent's truth board. Turn one side
      // off to see only what the OTHER player knew.
      sonar: boolean[];
    }
  | {
      kind: 'replay';
      // Self-contained: an imported file and a just-finished session replay identically.
      replay: Replay;
      // Board titles per seat (YOU / ADMIRAL / P1 …).
      labels: string[];
      // Timeline cursor: 0 = deployment, i = after the i-th action.
      ply: number;
      playing: boolean;
      speedMs: number;
      // Per player: draw their sonar intel over the opponent's truth board (see spectate).
      sonar: boolean[];
      // Where CLOSE returns to.
      from: 'gameover' | 'spectate' | 'menu';
    };

// Final ply index of a replay: one per action, plus the trailing concession frame when the
// game ended by forfeit (see replayFrames).
export function lastPly(replay: Replay): number {
  return replay.actions.length + (replay.forfeit !== undefined ? 1 : 0);
}

export interface AppState {
  screen: Screen;
  setup: Setup;
  session: Session | null;
  // Display preference: ping washes hue-decay red → blue as intel ages.
  pingHues: boolean;
}

export const PING_HUES_LS_KEY = 'flotilla.pingHues';

export const initialState: AppState = {
  screen: { kind: 'menu' },
  setup: {
    mode: 'duel',
    preset: 'FLOTILLA',
    cpuC: 'commodore',
    human: true,
    cpuA: 'admiral',
    cpuB: 'commander',
    seed: 1,
  },
  session: null,
  pingHues: typeof localStorage === 'undefined' || localStorage.getItem(PING_HUES_LS_KEY) !== '0',
};

export type UIAction =
  | { t: 'START_SETUP'; setup: Setup }
  | { t: 'PLACE_AT'; cell: Cell }
  | { t: 'ROTATE' }
  | { t: 'UNDO_PLACE' }
  | { t: 'RANDOMIZE_PLACEMENT' }
  | { t: 'CLEAR_PLACEMENT' }
  | { t: 'CONFIRM_PLACEMENT' }
  | { t: 'SET_TOOL'; tool: Tool }
  // Step the armed tool through the currently usable ones (keyboard cycling).
  | { t: 'CYCLE_TOOL'; delta: 1 | -1 }
  | { t: 'SELECT_SHIP'; ship: number | null }
  | { t: 'ENGINE_ACTION'; action: Action }
  // The human concedes: an engine-level loss (gameover screen), not a bail to menu.
  | { t: 'FORFEIT' }
  | { t: 'CPU_STEP' }
  | { t: 'CPU_FINISH_TURN' }
  | { t: 'SET_SPEED'; speedMs: number }
  | { t: 'TOGGLE_PAUSE' }
  // Spectate/replay: show or hide one player's sonar intel overlay.
  | { t: 'TOGGLE_SONAR'; player: PlayerId }
  | { t: 'OPEN_REPLAY'; replay: Replay; labels: string[]; from: 'gameover' | 'spectate' | 'menu' }
  | { t: 'REPLAY_SEEK'; ply: number }
  | { t: 'REPLAY_TOGGLE_PLAY' }
  | { t: 'REPLAY_SET_SPEED'; speedMs: number }
  | { t: 'CLOSE_REPLAY' }
  | { t: 'REMATCH' }
  | { t: 'TOGGLE_PING_HUES' }
  | { t: 'TO_MENU' };

// Bots are stateless, so instances are cached by name and arity (MELEE wraps the rank
// in a melee adapter; fewer samples since each decision also prices the other enemy).
const botCache = new Map<string, Bot>();
function botFor(name: BotName, melee: boolean): Bot {
  const key = melee ? `${name}:melee` : name;
  let bot = botCache.get(key);
  if (!bot) {
    bot = melee ? makeMelee(name, { samples: 300 }) : makeBot(name, { samples: 600 });
    botCache.set(key, bot);
  }
  return bot;
}

// Seat->rank map is worth hiding only with two or more DIFFERENT ranks facing a human.
export function concealsRanks(crew: BotName[], human: boolean): boolean {
  return human && crew.length > 1 && new Set(crew).size > 1;
}

// Bot roster per seat; null marks the human's seat. A concealed lineup's seating is
// shuffled from the seed, so a replay deals the same seats back.
function rosterFor(setup: Setup): { bots: (BotName | null)[]; concealed: boolean } {
  // The human, when playing, always takes seat 0; the bots fill the rest in order.
  const bots = [setup.cpuA, setup.cpuB, setup.cpuC];
  const seats = fleetsFor(setup.mode);
  if (!setup.human) return { bots: bots.slice(0, seats), concealed: false };
  const crew = bots.slice(0, seats - 1);
  if (!concealsRanks(crew, true)) return { bots: [null, ...crew], concealed: false };
  // Its own stream: the seed also deals fleets and drives the bots, and the seating must
  // not shift when either of those changes.
  const rng = mulberry32(setup.seed ^ 0x5ea7_5ea7);
  for (let i = crew.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [crew[i], crew[j]] = [crew[j]!, crew[i]!];
  }
  return { bots: [null, ...crew], concealed: true };
}

// Who opens: drawn per game from the seed, so no seat — the human's least of all — owns
// the first move. Its own stream, like the seating above. Fixed for the whole game.
function openerFor(setup: Setup): PlayerId {
  return Math.floor(mulberry32(setup.seed ^ 0x0be7_0be7)() * fleetsFor(setup.mode)) as PlayerId;
}

function startGame(
  app: Pick<AppState, 'pingHues'>,
  setup: Setup,
  fleets: AtLeastTwo<ShipPlacement[]>,
): AppState {
  const config = { ...PRESETS[setup.preset] };
  const roster = rosterFor(setup);
  const session: Session = {
    setup,
    config,
    placements: structuredClone(fleets),
    state: createGame(config, fleets, setup.seed, openerFor(setup)),
    actions: [],
    events: [],
    bots: roster.bots,
    concealed: roster.concealed,
  };
  const watching = !setup.human;
  if (watching) {
    return {
      ...app,
      setup,
      session,
      screen: { kind: 'spectate', speedMs: 300, paused: false, sonar: fleets.map(() => true) },
    };
  }
  return { ...app, setup, session, screen: { kind: 'game', perspective: 0, tool: 'FIRE', selectedShip: null } };
}

// Tools the human can arm right now. Derived from legalActionIds alone — it already prices
// in config flags, AP, pinned/moved ships, and decoy stock. Classify by decoded type, not id
// range: a FIRE/PING at a far seat lives in an extension plane, which matters once the
// nearest seat is sunk in the MELEE duel.
function usableTools(app: AppState): Tool[] {
  const session = app.session;
  if (app.screen.kind !== 'game' || !session || session.state.phase.kind !== 'playing') return [];
  const { state } = session;
  if (state.activePlayer !== app.screen.perspective || session.bots[state.activePlayer] !== null) return [];
  const kinds = new Set<string>(legalActionIds(state).map((id) => decodeAction(id).type));
  return TOOL_ORDER.filter((tool) => kinds.has(tool));
}

// Keep the armed tool usable after an action: affordability is not enough, since a special
// goes on cooldown, a moved ship can't move again and the decoy stock runs out. Fall back
// FIRE, then PING, then whatever is still legal.
function affordableTool(tool: Tool, state: GameState): Tool {
  const kinds = new Set<string>(legalActionIds(state).map((id) => decodeAction(id).type));
  if (kinds.has(tool)) return tool;
  return (['FIRE', 'PING', ...TOOL_ORDER] as Tool[]).find((t) => kinds.has(t)) ?? tool;
}

// Apply one engine action to the session, then route screens on flips/endings.
export function applyEngineAction(app: AppState, action: Action): AppState {
  const session = app.session;
  if (!session || session.state.phase.kind !== 'playing') return app;
  if (!legalActionIds(session.state).includes(encodeAction(action))) return app;

  // step() is deterministic today; seed the reserved rng from (game seed, action
  // index) so any future stochastic rule stays reproducible from the replay alone.
  const rng = mulberry32(session.setup.seed ^ (session.actions.length * 2654435761));
  const { state, events } = step(session.state, action, rng);
  const nextSession: Session = {
    ...session,
    state,
    actions: [...session.actions, action],
    events: [...session.events, ...events],
  };
  const app2: AppState = { ...app, session: nextSession };

  if (state.phase.kind !== 'playing') {
    return {
      ...app2,
      screen: app.screen.kind === 'spectate' ? app.screen : { kind: 'gameover' },
    };
  }
  // MELEE plays on past the first kill, but losing your own fleet ends YOUR game here;
  // the end screen reports where you stood when you went down.
  if (app.screen.kind === 'game' && isDead(state.players[app.screen.perspective]!)) {
    return { ...app2, screen: { kind: 'gameover' } };
  }
  const flipped = events.some((e) => e.type === 'turnEnded');
  if (!flipped) {
    if (app.screen.kind !== 'game' || state.activePlayer !== app.screen.perspective) return app2;
    const tool = affordableTool(app.screen.tool, state);
    if (tool === app.screen.tool) return app2;
    return { ...app2, screen: { ...app.screen, tool, selectedShip: null } };
  }

  if (app.screen.kind === 'game') {
    return { ...app2, screen: { ...app.screen, tool: 'FIRE', selectedShip: null } };
  }
  return app2;
}

// One CPU micro-action, decided purely from (observation, legal ids, seeded rng).
function cpuStep(app: AppState): AppState {
  const session = app.session;
  if (!session || session.state.phase.kind !== 'playing') return app;
  const seat = session.state.activePlayer;
  const botName = session.bots[seat];
  if (!botName) return app;
  const rng = mulberry32((session.setup.seed + seat * 7919) ^ (session.actions.length * 1013904223));
  const action = botFor(botName, session.state.players.length > 2)(
    observe(session.state, seat),
    legalActionIds(session.state),
    rng,
  );
  return applyEngineAction(app, action);
}

export function reducer(app: AppState, ui: UIAction): AppState {
  switch (ui.t) {
    case 'START_SETUP': {
      const setup = ui.setup;
      if (!setup.human) {
        const rng = mulberry32(setup.seed);
        const seats = fleetsFor(setup.mode);
        const fleets = Array.from({ length: seats }, () => randomFleet(rng)) as AtLeastTwo<ShipPlacement[]>;
        return startGame(app, setup, fleets);
      }
      return {
        ...app,
        setup,
        session: null,
        screen: { kind: 'placement', working: [], orient: 'H', rejected: null },
      };
    }

    case 'PLACE_AT': {
      if (app.screen.kind !== 'placement') return app;
      const screen = app.screen;
      const next = FLEET[screen.working.length];
      if (!next) return app;
      const occupied = screen.working.flatMap((p) =>
        cellsFor(p.origin, p.orient, FLEET.find((f) => f.kind === p.kind)!.length),
      );
      if (!canPlace(ui.cell, screen.orient, next.length, occupied)) {
        return { ...app, screen: { ...screen, rejected: ui.cell } };
      }
      return {
        ...app,
        screen: {
          ...screen,
          working: [...screen.working, { kind: next.kind, origin: ui.cell, orient: screen.orient }],
          rejected: null,
        },
      };
    }

    case 'ROTATE':
      if (app.screen.kind !== 'placement') return app;
      return {
        ...app,
        screen: { ...app.screen, orient: app.screen.orient === 'H' ? 'V' : 'H', rejected: null },
      };

    case 'UNDO_PLACE':
      if (app.screen.kind !== 'placement') return app;
      return { ...app, screen: { ...app.screen, working: app.screen.working.slice(0, -1), rejected: null } };

    case 'CLEAR_PLACEMENT':
      if (app.screen.kind !== 'placement') return app;
      return { ...app, screen: { ...app.screen, working: [], rejected: null } };

    case 'RANDOMIZE_PLACEMENT': {
      if (app.screen.kind !== 'placement') return app;
      const rng = mulberry32(((Math.random() * 0x7fffffff) | 0) >>> 0);
      return { ...app, screen: { ...app.screen, working: randomFleet(rng), rejected: null } };
    }

    case 'CONFIRM_PLACEMENT': {
      if (app.screen.kind !== 'placement') return app;
      const screen = app.screen;
      if (screen.working.length !== FLEET.length) return app;
      const rng = mulberry32(app.setup.seed ^ 0x5eed);
      const cpuSeats = fleetsFor(app.setup.mode) - 1;
      const fleets = [
        screen.working,
        ...Array.from({ length: cpuSeats }, () => randomFleet(rng)),
      ] as AtLeastTwo<ShipPlacement[]>;
      return startGame(app, app.setup, fleets);
    }

    case 'SET_TOOL':
      if (app.screen.kind !== 'game') return app;
      // FIRE is the neutral tool (Esc target, turn-flip default) and always
      // armable; anything else must be usable now, so a hotkey can't arm a
      // tool whose button is disabled.
      if (ui.tool !== 'FIRE' && !usableTools(app).includes(ui.tool)) return app;
      return { ...app, screen: { ...app.screen, tool: ui.tool, selectedShip: null } };

    case 'CYCLE_TOOL': {
      if (app.screen.kind !== 'game') return app;
      const tools = usableTools(app);
      if (tools.length === 0) return app;
      const cur = tools.indexOf(app.screen.tool);
      const next =
        cur < 0
          ? tools[ui.delta > 0 ? 0 : tools.length - 1]!
          : tools[(cur + ui.delta + tools.length) % tools.length]!;
      if (next === app.screen.tool) return app;
      return { ...app, screen: { ...app.screen, tool: next, selectedShip: null } };
    }

    case 'SELECT_SHIP':
      if (app.screen.kind !== 'game') return app;
      return { ...app, screen: { ...app.screen, selectedShip: ui.ship } };

    case 'ENGINE_ACTION':
      // Human input only: a stray Enter on a CPU turn must not PASS for the bot.
      if (app.session && app.session.bots[app.session.state.activePlayer] !== null) return app;
      return applyEngineAction(app, ui.action);

    case 'FORFEIT': {
      const session = app.session;
      if (app.screen.kind !== 'game' || !session || session.state.phase.kind !== 'playing') return app;
      const { state, events } = forfeit(session.state, app.screen.perspective);
      return {
        ...app,
        session: { ...session, state, events: [...session.events, ...events] },
        screen: { kind: 'gameover' },
      };
    }

    case 'CPU_STEP':
      return cpuStep(app);

    case 'CPU_FINISH_TURN': {
      // Skip button: burn through the rest of the CPU turn synchronously.
      let cur = app;
      let guard = 0;
      const seat = cur.session?.state.activePlayer;
      while (
        guard++ < 50 &&
        cur.session &&
        cur.session.state.phase.kind === 'playing' &&
        cur.session.state.activePlayer === seat &&
        seat !== undefined &&
        cur.session.bots[seat]
      ) {
        cur = cpuStep(cur);
      }
      return cur;
    }

    case 'SET_SPEED':
      if (app.screen.kind !== 'spectate') return app;
      return { ...app, screen: { ...app.screen, speedMs: ui.speedMs } };

    case 'TOGGLE_PAUSE':
      if (app.screen.kind !== 'spectate') return app;
      return { ...app, screen: { ...app.screen, paused: !app.screen.paused } };

    case 'TOGGLE_SONAR': {
      if (app.screen.kind !== 'spectate' && app.screen.kind !== 'replay') return app;
      const sonar: boolean[] = [...app.screen.sonar];
      sonar[ui.player] = !sonar[ui.player];
      return { ...app, screen: { ...app.screen, sonar } };
    }

    case 'OPEN_REPLAY':
      return {
        ...app,
        screen: {
          kind: 'replay',
          replay: ui.replay,
          labels: ui.labels,
          ply: 0,
          playing: false,
          speedMs: 300,
          // One toggle per fleet in the replay, all on.
          sonar: ui.replay.placements.map(() => true),
          from: ui.from,
        },
      };

    case 'REPLAY_SEEK': {
      if (app.screen.kind !== 'replay') return app;
      const last = lastPly(app.screen.replay);
      const ply = Math.max(0, Math.min(ui.ply, last));
      // Playback parks itself at the final ply instead of wrapping.
      return { ...app, screen: { ...app.screen, ply, playing: app.screen.playing && ply < last } };
    }

    case 'REPLAY_TOGGLE_PLAY': {
      if (app.screen.kind !== 'replay') return app;
      const screen = app.screen;
      const atEnd = screen.ply >= lastPly(screen.replay);
      // Pressing play while parked at the end restarts from deployment.
      return {
        ...app,
        screen: { ...screen, playing: !screen.playing, ply: !screen.playing && atEnd ? 0 : screen.ply },
      };
    }

    case 'REPLAY_SET_SPEED':
      if (app.screen.kind !== 'replay') return app;
      return { ...app, screen: { ...app.screen, speedMs: ui.speedMs } };

    case 'CLOSE_REPLAY': {
      if (app.screen.kind !== 'replay') return app;
      if (app.screen.from === 'gameover' && app.session) return { ...app, screen: { kind: 'gameover' } };
      if (app.screen.from === 'spectate' && app.session) {
        const sonar = app.session.placements.map(() => true);
        return { ...app, screen: { kind: 'spectate', speedMs: 300, paused: false, sonar } };
      }
      return { ...app, session: null, screen: { kind: 'menu' } };
    }

    case 'REMATCH': {
      const setup = { ...app.setup, seed: ((Math.random() * 0x7fffffff) | 0) >>> 0 };
      return reducer({ ...app, setup, session: null, screen: { kind: 'menu' } }, { t: 'START_SETUP', setup });
    }

    case 'TOGGLE_PING_HUES':
      return { ...app, pingHues: !app.pingHues };

    case 'TO_MENU':
      return { ...app, session: null, screen: { kind: 'menu' } };
  }
}
