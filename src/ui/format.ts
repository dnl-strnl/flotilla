import {
  cellLabel,
  redactEventsFor,
  type Event,
  type PlayerId,
  type ShipKind,
} from '../engine';

export const SHIP_LABEL: Record<ShipKind, string> = {
  carrier: 'LEVIATHAN',
  battleship: 'DREADNOUGHT',
  cruiser: 'REAPER',
  submarine: 'DRONE',
  destroyer: 'MAKO',
};

export interface LogLine {
  key: number;
  turn: number;
  text: string;
  tone: 'neutral' | 'hit' | 'miss' | 'ping' | 'friendly' | 'alert' | 'divider';
}

// Terse teletype log for one side's view of the game.
export function logLinesFor(viewer: PlayerId, events: Event[]): LogLine[] {
  const visible = redactEventsFor(viewer, events);
  const lines: LogLine[] = [];
  let key = 0;
  const push = (turn: number, text: string, tone: LogLine['tone']) =>
    lines.push({ key: key++, turn, text, tone });

  for (const e of visible) {
    switch (e.type) {
      case 'turnStarted':
        push(
          e.turn,
          e.player === viewer
            ? `── T${e.turn} · YOUR TURN · AP ${e.budget} ──`
            : `── T${e.turn} · ENEMY TURN ──`,
          'divider',
        );
        break;
      case 'fire': {
        const at = cellLabel(e.cell);
        // A spray arrives as four ordinary shells; naming the verb is the only thing that
        // tells the reader the four lines were one action and one price.
        const verb = e.spray ? 'SPRAY' : 'FIRE';
        if (e.by === viewer) {
          const outcome =
            e.reported === 'SUNK'
              ? `SUNK ${SHIP_LABEL[e.sunkShip!.kind]}`
              : e.reported;
          push(e.turn, `${verb} ${at} — ${outcome}`, e.reported === 'MISS' ? 'miss' : 'hit');
        } else if (e.target !== viewer) {
          // Someone else's board took it. Both ends are public, so the line names them.
          const outcome =
            e.reported === 'SUNK' ? `SUNK ${SHIP_LABEL[e.sunkShip!.kind]}` : e.reported;
          push(e.turn, `P${e.by + 1} → P${e.target + 1} ${at} ${verb === 'SPRAY' ? '⬛ ' : ''}— ${outcome}`, 'neutral');
        } else {
          const outcome = e.decoy
            ? 'DECOY ABSORBED'
            : e.hitShip
              ? `${SHIP_LABEL[e.hitShip]} ${e.reported === 'SUNK' ? 'LOST' : 'HIT'}`
              : 'MISS';
          push(
            e.turn,
            `INCOMING ${verb} ${at} FROM P${e.by + 1} — ${outcome}`,
            e.hitShip ? 'alert' : e.decoy ? 'friendly' : 'miss',
          );
        }
        break;
      }
      case 'scan':
        push(
          e.turn,
          `SCAN ${cellLabel(e.cell)} 2×2 — ${e.live.length ? `LIVE ${e.live.map(cellLabel).join(' ')}` : 'CLEAR'}`,
          'ping',
        );
        break;
      case 'echo':
        // Public at every end, so it is worth a line on every seat's log.
        push(
          e.turn,
          e.by === viewer
            ? `ECHO ▸ P${e.target + 1} 4×4 ${cellLabel(e.cells[0]!)} — OCCUPANCY ${e.occupancy}`
            : `P${e.by + 1} ECHOED P${e.target + 1} ${cellLabel(e.cells[0]!)} — OCCUPANCY ${e.occupancy}`,
          e.contact ? 'alert' : 'neutral',
        );
        break;
      case 'toolUnlocked':
        push(e.turn, 'SPECIAL TOOLS UNLOCKED — SHIP LOST', 'friendly');
        break;
      case 'ping':
        push(e.turn, `PING ${cellLabel(e.center)} — ${e.contact ? 'CONTACT' : 'CLEAR'}`, 'ping');
        // The sweep dredged a fresh trail of vacated cells.
        if (e.wakes?.length)
          push(
            e.turn,
            `WAKE ${e.wakes.flatMap((w) => w.cells).map(cellLabel).join(' ')} — FRESH TRAIL DREDGED`,
            'ping',
          );
        break;
      case 'enemyActivity':
        // Opaque by design: AP was spent, but not on what.
        push(e.turn, 'ENEMY ACTIVITY — UNRESOLVED', 'neutral');
        break;
      case 'move':
        push(e.turn, `REPOSITION ${cellLabel(e.from)}→${cellLabel(e.to)}`, 'friendly');
        break;
      case 'decoyPlaced':
        push(e.turn, `DECOY DEPLOYED ${cellLabel(e.cell)}`, 'friendly');
        break;
      case 'decoySpent':
        push(e.turn, `DECOY EXPENDED ${cellLabel(e.cell)}`, 'friendly');
        break;
      case 'gameOver':
        push(
          e.turn,
          e.result === 'draw'
            ? '■ GAME OVER — DRAW (TURN CAP)'
            : e.winner === viewer
              ? `■ GAME OVER — VICTORY${
                  e.forfeit !== undefined
                    ? ' (ENEMY STRUCK COLORS)'
                    : e.eliminated !== undefined && e.eliminated !== viewer
                      ? ` (P${e.eliminated + 1} ELIMINATED — DECIDED ON TONNAGE)`
                      : ''
                }`
              : `■ GAME OVER — DEFEAT${
                  e.forfeit !== undefined
                    ? ' (COLORS STRUCK)'
                    : e.eliminated !== undefined && e.eliminated !== viewer
                      ? ` (P${e.eliminated + 1} ELIMINATED — DECIDED ON TONNAGE)`
                      : ''
                }`,
          'alert',
        );
        break;
      case 'passed':
      case 'turnEnded':
        break;
    }
  }
  return lines;
}

// Full-truth log for the spectate screen.
export function logLinesTruth(events: Event[]): LogLine[] {
  const lines: LogLine[] = [];
  let key = 0;
  const push = (turn: number, text: string, tone: LogLine['tone']) =>
    lines.push({ key: key++, turn, text, tone });
  for (const e of events) {
    switch (e.type) {
      case 'turnStarted':
        push(e.turn, `── T${e.turn} · P${e.player + 1} TURN · AP ${e.budget} ──`, 'divider');
        break;
      case 'fire': {
        const outcome = e.decoy
          ? 'FAKE HIT (DECOY)'
          : e.reported === 'SUNK'
            ? `SUNK ${SHIP_LABEL[e.sunkShip!.kind]}`
            : e.reported;
        push(
          e.turn,
          `P${e.by + 1} ${e.spray ? 'SPRAY' : 'FIRE'} ${cellLabel(e.cell)} — ${outcome}`,
          e.reported === 'MISS' ? 'miss' : 'hit',
        );
        break;
      }
      case 'ping':
        push(e.turn, `P${e.by + 1} PING ${cellLabel(e.center)} — ${e.contact ? 'CONTACT' : 'CLEAR'}`, 'ping');
        break;
      case 'move':
        push(e.turn, `P${e.player + 1} MOVED ${cellLabel(e.from)}→${cellLabel(e.to)}`, 'friendly');
        break;
      case 'decoyPlaced':
        push(e.turn, `P${e.player + 1} DECOY ${cellLabel(e.cell)}`, 'friendly');
        break;
      case 'decoySpent':
        push(e.turn, `P${e.player + 1} DECOY SPENT ${cellLabel(e.cell)}`, 'friendly');
        break;
      case 'gameOver':
        push(
          e.turn,
          e.result === 'draw'
            ? '■ DRAW — TURN CAP'
            : e.forfeit !== undefined
              ? `■ P${e.forfeit + 1} STRIKES COLORS — P${e.winner! + 1} WINS`
              : e.eliminated !== undefined
                ? `■ P${e.eliminated + 1} ELIMINATED — P${e.winner! + 1} WINS ON TONNAGE`
                : `■ P${e.winner! + 1} WINS`,
          'alert',
        );
        break;
      case 'enemyActivity':
        break; // redaction-only; the spectate deck sees full truth
      default:
        break;
    }
  }
  return lines;
}
