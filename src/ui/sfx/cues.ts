import {
  encodeAction,
  legalActionIds,
  redactEventsFor,
  replayFrames,
  type Event,
  type PlayerId,
  type Replay,
  type ReplayFrame,
} from '../../engine';
import type { Beat } from './slots';
import type { AppState, UIAction } from '../state';

// Pure mapping: redacted events → beats for `me`'s ears. Caller pre-redacts via
// redactEventsFor, so this cannot see (or leak) the defender's secrets.

// Gap between the shells of one spray, so four results read as a burst, not one thud.
const SPRAY_SHELL_MS = 90;

export function beatsForEvents(events: Event[], me: PlayerId): Beat[] {
  const out: Beat[] = [];
  // Position of the current shell within its spray: one launch sound for the block, then
  // one result per cell, walked forward in time.
  let shell = 0;
  for (const e of events) {
    if (e.type !== 'fire' || !e.spray) shell = 0;
    switch (e.type) {
      case 'turnStarted':
        if (e.player === me) out.push({ cue: 'turn.start', at: 0 });
        break;

      case 'fire': {
        const mine = e.by === me;
        const atMe = e.target === me;
        // Fire between two other fleets is silent, except a SUNK, which is public news.
        const audible = mine || atMe || e.reported === 'SUNK';
        if (audible) {
          // One launch for the whole block, not one per cell.
          if (mine && shell === 0) out.push({ cue: 'fire.send', at: 0 });
          const result: Beat['cue'] =
            e.reported === 'SUNK'
              ? atMe
                ? 'fire.sunk.own'
                : 'fire.sunk.enemy'
              : e.reported === 'HIT'
                ? 'fire.hit'
                : 'fire.miss';
          out.push({ cue: result, at: (mine ? 260 : 0) + shell * SPRAY_SHELL_MS });
        }
        // Count every shell of a block, heard or not, so two sinkings inside one spray land
        // apart instead of on the same millisecond.
        if (e.spray) shell++;
        break;
      }

      case 'ping':
        // Only ever your own ping — the opponent's arrives as enemyActivity.
        out.push({ cue: 'ping.send', at: 0 });
        out.push({ cue: e.contact ? 'ping.positive' : 'ping.negative', at: 420 });
        // A dredged trail answers as a second, later return.
        if (e.wakes?.length) out.push({ cue: 'ping.positive', at: 720 });
        break;

      case 'scan':
        // Your own sweep only — a rival's arrives as enemyActivity. Same beats as a ping.
        out.push({ cue: 'ping.send', at: 0 });
        out.push({ cue: e.contact ? 'ping.positive' : 'ping.negative', at: 420 });
        break;

      case 'echo':
        // Public sweep, audible at every seat: a rival's opens with their activity rumble.
        out.push(e.by === me ? { cue: 'ping.send', at: 0 } : { cue: 'enemy.activity', at: 0 });
        out.push({ cue: e.contact ? 'ping.positive' : 'ping.negative', at: 420 });
        break;

      case 'move':
        out.push({ cue: 'move.ship', at: 0 });
        break;

      case 'decoyPlaced':
        out.push({ cue: 'decoy.deploy', at: 0 });
        break;

      case 'decoySpent':
        // Defender-side only, and silent on purpose: the shot that spent it
        // already played fire.hit, and a second sound would mark the bluff.
        break;

      case 'passed':
        break;

      case 'turnEnded':
        if (e.player === me) out.push({ cue: 'turn.end', at: 0 });
        break;

      case 'enemyActivity':
        out.push({ cue: 'enemy.activity', at: 0 });
        break;

      case 'fleetEliminated':
        // Only your own (a rival's SUNK already sounded). No gameOver arrives for a seat
        // knocked out while MELEE plays on, so this is your defeat cue.
        if (e.player === me) out.push({ cue: 'end.defeat', at: 500 });
        break;

      case 'gameOver':
        out.push({
          cue: e.result === 'draw' ? 'end.draw' : e.winner === me ? 'end.victory' : 'end.defeat',
          at: 500,
        });
        break;
    }
  }
  return out;
}

// UI actions with no engine event behind them → chrome sound; null where the engine
// narrates on its own, so nothing double-fires.
function chromeBeat(ui: UIAction): Beat | null {
  switch (ui.t) {
    case 'START_SETUP':
      return { cue: 'game.start', at: 0 };
    case 'PLACE_AT':
      return { cue: 'ship.place', at: 0 };
    case 'ROTATE':
      return { cue: 'ship.rotate', at: 0 };
    case 'UNDO_PLACE':
    case 'CLEAR_PLACEMENT':
      return { cue: 'ui.back', at: 0 };
    case 'RANDOMIZE_PLACEMENT':
      return { cue: 'fleet.random', at: 0 };
    case 'CONFIRM_PLACEMENT':
      return { cue: 'fleet.ready', at: 0 };
    case 'SET_TOOL':
    case 'CYCLE_TOOL':
    case 'SET_SPEED':
    case 'TOGGLE_PAUSE':
    case 'TOGGLE_PING_HUES':
    case 'TOGGLE_SONAR':
    case 'REPLAY_TOGGLE_PLAY':
    case 'REPLAY_SET_SPEED':
      return { cue: 'ui.toggle', at: 0 };
    case 'SELECT_SHIP':
      return ui.ship === null ? null : { cue: 'ship.pickup', at: 0 };
    case 'REMATCH':
    case 'OPEN_REPLAY':
      return { cue: 'ui.click', at: 0 };
    case 'CLOSE_REPLAY':
      return { cue: 'ui.back', at: 0 };
    case 'TO_MENU':
      return { cue: 'ui.back', at: 0 };
    case 'ENGINE_ACTION':
    case 'CPU_STEP':
    case 'CPU_FINISH_TURN':
    case 'FORFEIT':
      return null; // the resulting events carry the sound
    case 'REPLAY_SEEK':
      return null; // fires every playback tick — a beat per ply would be noise
  }
}

// Whose ears the screen belongs to. Spectate has no human; seat 0 listens.
export function earsOf(app: AppState): PlayerId {
  if (app.screen.kind === 'game') return app.screen.perspective;
  return 0;
}

// replayFrames re-executes the whole game, and playback asks once per ply — memoize per
// Replay object (the screen holds one for its whole lifetime).
const framesCache = new WeakMap<Replay, ReplayFrame[]>();
function framesOf(replay: Replay): ReplayFrame[] {
  let frames = framesCache.get(replay);
  if (!frames) {
    frames = replayFrames(replay);
    framesCache.set(replay, frames);
  }
  return frames;
}

// One reducer transition → everything it should sound like (the whole audio decision layer;
// the player downstream only obeys). Sources in hearing order: rejection, chrome, redacted
// engine events.
export function beatsForTransition(prev: AppState, next: AppState, ui: UIAction): Beat[] {
  const me = earsOf(next);

  // 1. rejections. A bad placement flags the cell; an unaffordable action is a no-op.
  const rejectedCell =
    next.screen.kind === 'placement' &&
    next.screen.rejected !== null &&
    (prev.screen.kind !== 'placement' || prev.screen.rejected !== next.screen.rejected);
  if (rejectedCell) return [{ cue: 'ship.invalid', at: 0 }];
  if (prev === next) return [];

  const out: Beat[] = [];
  const chrome = chromeBeat(ui);
  if (chrome) out.push(chrome);

  // 2. the AP pip draining, layered under whatever the action itself sounds like.
  const spentAP =
    ui.t === 'ENGINE_ACTION' &&
    ui.action.type !== 'PASS' &&
    prev.session !== null &&
    next.session !== null &&
    prev.session.state.activePlayer === me;
  if (spentAP) out.push({ cue: 'ap.spend', at: 0 });

  // 3. replay playback: a single-ply advance sounds that ply's redacted events, exactly
  //    like the game did. Scrubs and jumps stay silent.
  if (
    ui.t === 'REPLAY_SEEK' &&
    prev.screen.kind === 'replay' &&
    next.screen.kind === 'replay' &&
    next.screen.replay === prev.screen.replay &&
    next.screen.ply === prev.screen.ply + 1
  ) {
    const frame = framesOf(next.screen.replay)[next.screen.ply];
    if (frame) out.push(...beatsForEvents(redactEventsFor(me, frame.events), me));
  }

  // 4. engine events, redacted for the listener before they are ever read.
  const before = prev.session?.events.length ?? 0;
  const fresh = next.session?.events.slice(before) ?? [];
  if (fresh.length) out.push(...beatsForEvents(redactEventsFor(me, fresh), me));

  // 5. the armed tool fell back to what the remaining AP affords: say so after the
  //    action's own result. A turn flip resets it too, but turn.end narrates that.
  if (
    ui.t === 'ENGINE_ACTION' &&
    prev.screen.kind === 'game' &&
    next.screen.kind === 'game' &&
    prev.screen.tool !== next.screen.tool &&
    !fresh.some((e) => e.type === 'turnEnded')
  ) {
    out.push({ cue: 'tool.autoswitch', at: 450 });
  }

  return out;
}

// Refused engine actions return the identical state object → React bails →
// beatsForTransition never runs; so refusal is decided here, from the same legality check
// the reducer uses.
export function beatForRefusal(app: AppState, ui: UIAction): Beat | null {
  if (ui.t !== 'ENGINE_ACTION') return null;
  const session = app.session;
  if (!session || session.state.phase.kind !== 'playing') return null;
  if (legalActionIds(session.state).includes(encodeAction(ui.action))) return null;
  return { cue: 'ap.insufficient', at: 0 };
}
