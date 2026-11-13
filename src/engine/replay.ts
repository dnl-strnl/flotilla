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
  // What the engine answered, one token per action (see digestOf). Events are re-derived.
  digest: string;
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
    version: (placements.length > 2 ? 3 : 2) as 2 | 3,
    config,
    seed,
    firstPlayer,
    placements,
    actions,
    digest: digestOf(events),
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
  };
}

// Shell H/M/S, sweep c/'.', ECHO occupancy base-36, MOVE '>', DECOY 'd', PASS '-'.
export function digestOf(events: readonly Event[]): string {
  let out = '';
  for (const e of events) {
    switch (e.type) {
      case 'fire':
        out += e.reported[0];
        break;
      case 'ping':
      case 'scan':
        out += e.contact ? 'c' : '.';
        break;
      case 'echo':
        out += e.occupancy.toString(36);
        break;
      case 'move':
        out += '>';
        break;
      case 'decoyPlaced':
        out += 'd';
        break;
      case 'passed':
        out += '-';
        break;
      default:
        break;
    }
  }
  return out;
}

// Does today's engine still answer what the file recorded? Throws on an illegal action.
export function verifyReplay(replay: Replay): boolean {
  return digestOf(runReplay(replay).events) === replay.digest;
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
