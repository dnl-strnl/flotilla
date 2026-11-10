import type {
  Action,
  AtLeastTwo,
  Event,
  GameConfig,
  GameState,
  PlayerId,
  ShipPlacement,
} from './types';
import { createGame } from './game';
import { mulberry32 } from './rng';
import { forfeit, step } from './step';

export interface Replay {
  // 2 = two fleets, MOVE carries a compass MoveDir; 3 = MELEE. Seat order is not
  // stored: it is a fixed round-robin from firstPlayer.
  version: 2 | 3;
  config: GameConfig;
  seed: number;
  firstPlayer: PlayerId;
  placements: AtLeastTwo<ShipPlacement[]>;
  // Full micro-action sequence, in order.
  actions: Action[];
  // Full-truth event log (includes both sides' private events).
  events: Event[];
  // The game ended by this player striking colors after the last action. Out-of-band, not
  // an actions[] entry — see engine forfeit().
  forfeit?: PlayerId;
}

export function exportReplay(
  config: GameConfig,
  seed: number,
  firstPlayer: PlayerId,
  placements: AtLeastTwo<ShipPlacement[]>,
  actions: Action[],
  events: Event[],
  forfeitBy?: PlayerId,
): Replay {
  return structuredClone({
    // Two-fleet exports stay byte-identical to every replay already in the wild.
    version: (placements.length > 2 ? 3 : 2) as 2 | 3,
    config,
    seed,
    firstPlayer,
    placements,
    actions,
    events,
    ...(forfeitBy !== undefined ? { forfeit: forfeitBy } : {}),
  });
}

// One frame per ply: frame 0 = deployment, frame i = state AFTER actions[i-1] + that action
// + its events. Re-executes the engine, so a tampered replay throws. A Replay.forfeit
// appends one final action-less frame for the concession.
export interface ReplayFrame {
  state: GameState;
  // null on frame 0 (deployment) and on a trailing forfeit frame.
  action: Action | null;
  events: Event[];
}

// Replays saved before the SHOT → FIRE rename spell the action 'SHOT' and its event 'shot'.
// Replays saved before specialTools was a flag lack it; three-seat games then were all
// FLOTILLA, which has it on, and two-seat games never read it. meleeFullAp likewise, but a
// three-seat replay saved under the old floor-4 rule will not reproduce.
// Pure: returns an upgraded copy, the input is untouched; current replays pass through.
export function upgradeReplay(replay: Replay): Replay {
  const legacy = (t: string, from: string, to: string) => (t === from ? to : t);
  return {
    ...replay,
    config: {
      ...replay.config,
      specialTools: replay.config.specialTools ?? true,
      meleeFullAp: replay.config.meleeFullAp ?? true,
    },
    actions: replay.actions.map(
      (a) => ({ ...a, type: legacy(a.type, 'SHOT', 'FIRE') }) as Action,
    ),
    events: replay.events.map((e) => ({ ...e, type: legacy(e.type, 'shot', 'fire') }) as Event),
  };
}

export function replayFrames(saved: Replay): ReplayFrame[] {
  const replay = upgradeReplay(saved);
  const rng = mulberry32(replay.seed);
  let state = createGame(replay.config, replay.placements, replay.seed, replay.firstPlayer);
  const frames: ReplayFrame[] = [{ state, action: null, events: [] }];
  for (const action of replay.actions) {
    const result = step(state, action, rng);
    state = result.state;
    frames.push({ state, action, events: result.events });
  }
  if (replay.forfeit !== undefined && state.phase.kind === 'playing') {
    const result = forfeit(state, replay.forfeit);
    frames.push({ state: result.state, action: null, events: result.events });
  }
  return frames;
}

// Re-execute a replay from scratch. Used for determinism verification.
export function runReplay(replay: Replay): { state: GameState; events: Event[] } {
  const frames = replayFrames(replay);
  return { state: frames[frames.length - 1]!.state, events: frames.flatMap((f) => f.events) };
}
