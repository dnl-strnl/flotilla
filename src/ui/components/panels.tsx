import { useEffect, useRef, useState } from 'react';
import {
  DECOY_BASE,
  MOVE_BASE,
  MOVE_DIRS,
  AP_CAP,
  AP_COST,
  AP_FLOOR,
  ECHO_SIZE,
  MAX_DECOYS,
  SCAN_SIZE,
  SPRAY_SIZE,
  TOOL_COOLDOWN,
  maxTurnsFor,
  toolCost,
  toolsUnlocked,
  type MoveDir,
  type Observation,
  type ToolId,
} from '../../engine';
import type { LogLine } from '../format';
import { SHIP_LABEL } from '../format';
import { END_TURN_KEY, SPECIAL_TOOLS, TOOL_KEY, type Tool } from '../state';

// Tools the fleet has armed (it has lost a ship) and that are off cooldown.
const readyTools = (obs: Observation): ToolId[] =>
  toolsUnlocked(obs.myShips) ? SPECIAL_TOOLS.filter((id) => obs.myToolCooldowns[id] === 0) : [];

const DIR_GLYPH: Record<MoveDir, string> = { N: '▴', S: '▾', W: '◂', E: '▸' };
const DIR_WORD: Record<MoveDir, string> = { N: 'up', S: 'down', W: 'left', E: 'right' };

export function APBar(props: { ap: number; budget: number }) {
  const segments = Array.from({ length: Math.max(props.budget, 1) }, (_, i) => i < props.ap);
  return (
    <div className="ap-bar" aria-label={`AP ${props.ap} of ${props.budget}`}>
      <span className="micro-label">AP</span>
      <span className="ap-segments">
        {segments.map((on, i) => (
          <span key={i} className={on ? 'ap-seg on' : 'ap-seg'} />
        ))}
      </span>
      <span className="ap-count">{props.ap}/{props.budget}</span>
    </div>
  );
}

/** Schematic fleet readout with per-cell damage blocks and move controls. */
export function FleetStatus(props: {
  obs: Observation;
  legal: number[];
  showMoveControls: boolean;
  onMove: (ship: number, dir: MoveDir) => void;
}) {
  const { obs, legal } = props;
  return (
    <div className="fleet-status">
      <div className="micro-label">FLEET STATUS</div>
      {obs.myShips.map((ship, idx) => {
        const pinned = !ship.sunk && ship.hits.some(Boolean);
        return (
          <div key={ship.kind} className={`fleet-row${ship.sunk ? ' sunk' : ''}`}>
            <span className="fleet-name">{SHIP_LABEL[ship.kind]}</span>
            <span className="fleet-blocks">
              {ship.hits.map((hit, i) => (
                <span key={i} className={hit ? 'dmg-block hit' : 'dmg-block'} />
              ))}
            </span>
            <span className="fleet-state">
              {ship.sunk ? 'LOST' : pinned ? 'PINNED' : ''}
            </span>
            {props.showMoveControls && !ship.sunk && (
              <span className="move-controls">
                {MOVE_DIRS.map((dir, dirIndex) => (
                  <button
                    key={dir}
                    type="button"
                    className="btn-micro"
                    disabled={!legal.includes(MOVE_BASE + idx * 4 + dirIndex)}
                    title={`move one cell ${DIR_WORD[dir]}`}
                    onClick={() => props.onMove(idx, dir)}
                  >
                    {DIR_GLYPH[dir]}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
      {obs.config.decoys && (
        <div className="fleet-row decoys-row">
          <span className="fleet-name">DECOYS</span>
          <span className="fleet-blocks">
            {Array.from({ length: 2 }, (_, i) => (
              <span key={i} className={i < obs.myDecoysLeft ? 'dmg-block decoy-avail' : 'dmg-block'} />
            ))}
          </span>
          <span className="fleet-state">{obs.myDecoysLeft} LEFT</span>
        </div>
      )}
      {/* Special tools: ready, cooling, or still locked — shown all game where they exist. */}
      {obs.config.specialTools && obs.playerCount > 2 && (
        <div className="fleet-row decoys-row">
          <span className="fleet-name">TOOLS</span>
          <span className="fleet-blocks">
            {SPECIAL_TOOLS.map((id) => {
              const cooling = obs.myToolCooldowns[id];
              const ready = cooling === 0 && toolsUnlocked(obs.myShips);
              return (
                <span
                  key={id}
                  title={`${id} — ${
                    !toolsUnlocked(obs.myShips)
                      ? 'unlocks when you lose a ship'
                      : ready
                        ? 'ready'
                        : `ready in ${cooling} turn${cooling === 1 ? '' : 's'}`
                  }`}
                  className={ready ? 'dmg-block decoy-avail' : 'dmg-block'}
                />
              );
            })}
          </span>
          <span className="fleet-state">{readyTools(obs).length} READY</span>
        </div>
      )}
    </div>
  );
}

// Newest-first feed: turn blocks (divider + its lines) reverse as units, so dividers stay
// above their entries while lines within a turn keep order.
function newestFirst(lines: LogLine[]): LogLine[] {
  const blocks: LogLine[][] = [];
  for (const line of lines) {
    if (line.tone === 'divider' || blocks.length === 0) blocks.push([line]);
    else blocks[blocks.length - 1]!.push(line);
  }
  return blocks.reverse().flat();
}

export function EventLog(props: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // Newest content is at the top, so snap there as entries arrive.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = 0;
  }, [props.lines.length]);
  const ordered = newestFirst(props.lines);
  return (
    <div className="event-log-wrap">
      <div className="micro-label">EVENT LOG</div>
      <div className="event-log" ref={ref}>
        {ordered.map((line) => (
          <div key={line.key} className={`log-line tone-${line.tone}`}>
            {line.tone !== 'divider' && <span className="log-turn">T{line.turn}</span>}
            {line.tone !== 'divider' && <span className="log-sep">▸</span>}
            <span className="log-text">{line.text}</span>
          </div>
        ))}
        {ordered.length === 0 && <div className="log-line tone-neutral">— AWAITING CONTACT —</div>}
      </div>
    </div>
  );
}

// The four MELEE specials, in row order. One use each.
const TOOL_HINT: Record<ToolId, string> = {
  SPRAY: 'a 2×2 block of fire on one enemy grid, clicked cell is its top-left',
  SCAN: 'a private 2×2 close look that marks exactly which cells hold a live ship',
  FORK: 'one cell, fired into both enemy grids at once',
  ECHO: 'a 4×4 sweep reporting its OCCUPANCY (live cells under it) — and EVERYONE hears it',
};

const ACTION_DEFS: { tool: Tool; cost: number; hint: string }[] = [
  { tool: 'FIRE', cost: AP_COST.FIRE, hint: 'fire at a cell on the targeting grid' },
  { tool: 'PING', cost: AP_COST.PING, hint: 'radar a 3×3 region — boolean contact' },
  { tool: 'MOVE', cost: AP_COST.MOVE, hint: 'click a ship on your grid, then a highlighted destination' },
  { tool: 'DECOY', cost: AP_COST.DECOY, hint: 'place a false contact on your own grid' },
];

export function ActionBar(props: {
  obs: Observation;
  legal: number[];
  tool: string;
  myTurn: boolean;
  onTool: (tool: Tool) => void;
  onEndTurn: () => void;
}) {
  const { obs, legal, myTurn } = props;
  const enabledFor = (tool: string, cost: number): boolean => {
    if (!myTurn || obs.ap < cost) return false;
    if (tool === 'PING') return obs.config.pings;
    if (tool === 'MOVE') return obs.config.movement && legal.some((id) => id >= MOVE_BASE && id < DECOY_BASE);
    if (tool === 'DECOY') return obs.config.decoys && obs.myDecoysLeft > 0;
    return true;
  };
  const visible = ACTION_DEFS.filter((d) => {
    if (d.tool === 'PING') return obs.config.pings;
    if (d.tool === 'MOVE') return obs.config.movement;
    if (d.tool === 'DECOY') return obs.config.decoys;
    return true;
  });
  const showTools = obs.config.specialTools && obs.playerCount > 2;
  // With FIRE the only action (CLASSIC, SALVO), PASS joins it on one row instead of stacking.
  const passInline = visible.length === 1 && !showTools;
  const pass = (
    <button
      type="button"
      className="btn-action end-turn"
      disabled={!myTurn}
      title={`[${END_TURN_KEY} / Enter] end turn, forfeiting remaining AP`}
      onClick={props.onEndTurn}
    >
      <span className="action-key">{END_TURN_KEY}</span>
      <span className="action-name">PASS</span>
      <span className="action-cost">0 AP</span>
    </button>
  );
  return (
    <>
      <div className="action-bar">
        {visible.map((d) => (
          <button
            key={d.tool}
            type="button"
            title={`[${TOOL_KEY[d.tool]}] ${d.hint}`}
            className={`btn-action${props.tool === d.tool ? ' selected' : ''}`}
            disabled={!enabledFor(d.tool, d.cost)}
            onClick={() => props.onTool(d.tool)}
          >
            <span className="action-key">{TOOL_KEY[d.tool]}</span>
            <span className="action-name">{d.tool}</span>
            <span className="action-cost">{d.cost} AP</span>
          </button>
        ))}
        {passInline && pass}
      </div>
      {showTools && (
        <div className="action-bar action-bar--tools">
          {SPECIAL_TOOLS.map((id) => {
            const cost = toolCost(id);
            const cooling = obs.myToolCooldowns[id];
            const locked = !toolsUnlocked(obs.myShips);
            const ready = !locked && cooling === 0;
            return (
              <button
                key={id}
                type="button"
                title={`[${TOOL_KEY[id]}] ${TOOL_HINT[id]}${locked ? ' — unlocks when you lose a ship' : !ready ? ` — ready in ${cooling} turn${cooling === 1 ? '' : 's'}` : ''}`}
                className={`btn-action btn-tool${props.tool === id ? ' selected' : ''}`}
                disabled={!myTurn || !ready || obs.ap < cost}
                onClick={() => props.onTool(id)}
              >
                <span className="action-key">{TOOL_KEY[id]}</span>
                <span className="action-name">{id}</span>
                <span className="action-cost">{!locked && !ready ? `IN ${cooling}` : `${cost} AP`}</span>
              </button>
            );
          })}
        </div>
      )}
      {!passInline && <div className="action-bar">{pass}</div>}
      {visible.length > 1 && <div className="hotkey-hint">Q / E / TAB — CYCLE ACTIONS</div>}
    </>
  );
}

// One-line tool summaries for the three-fleet block, keyed for SPECIAL_TOOLS' hotkey order.
const TOOL_BRIEF: Record<ToolId, string> = {
  SPRAY: `${SPRAY_SIZE}×${SPRAY_SIZE} block of shells into one enemy grid.`,
  SCAN: `private ${SCAN_SIZE}×${SCAN_SIZE} look that marks exactly which cells hold a ship.`,
  FORK: 'one cell, shelled on every enemy grid at once. Retires in the duel.',
  ECHO: `public ${ECHO_SIZE}×${ECHO_SIZE} count of ship cells; every fleet hears it. Retires in the duel.`,
};

export function RulesPanel(props: { config: Observation['config']; seats: number }) {
  const { config, seats } = props;
  const [open, setOpen] = useState(false);
  const melee = seats > 2;
  return (
    <div className="rules-panel">
      <button
        type="button"
        className={`btn-micro rules-toggle${open ? ' selected' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {open ? '▾ RULES REF' : '▸ RULES REF'}
      </button>
      {open && (
        <div className="rules-body">
          {config.salvoBudget ? (
            <p>
              AP/turn = ships afloat (max {AP_CAP}, min {AP_FLOOR} so you can always shoot).
              Unspent AP is lost; the turn ends itself once nothing is affordable.
            </p>
          ) : (
            <p>One shot per turn.</p>
          )}
          <p><b>FIRE · {AP_COST.FIRE} AP</b> — fire at a cell → HIT / MISS / SUNK. Markers stick to cells, not ships.</p>
          {config.pings && (
            <p><b>PING · {AP_COST.PING} AP</b> — 3×3 sonar → CONTACT or CLEAR. Only unhit ship cells and live decoys answer. Ages visibly.</p>
          )}
          {config.movement && (
            <p><b>MOVE · {AP_COST.MOVE} AP</b> — slide one undamaged ship one cell N/S/E/W (orientation kept), once per ship per turn. Damaged ships are pinned. Leaves a wake (≈) enemy sonar can catch on their next turn.</p>
          )}
          {config.decoys && (
            <p><b>DECOY · {AP_COST.DECOY} AP</b> — max {MAX_DECOYS}/game. Answers sonar; absorbs one shot as a fake HIT, then dies silently.</p>
          )}
          <p><b>PASS · {AP_COST.PASS} AP</b> — end turn.</p>
          {melee ? (
            <>
              <p className="rules-body-head">THREE FLEETS</p>
              <p>
                <b>LAST FLEET AFLOAT</b> — a sunk fleet is out and forfeits its turns; the
                survivors duel on. Draw at turn {maxTurnsFor(seats)}.
              </p>
              {config.salvoBudget && config.meleeFullAp && (
                <p>
                  <b>AP</b> — a full {AP_CAP} every turn while three fleets are up, ships lost or not
                  {config.finalDuelFullAp ? '; the final duel keeps it.' : '.'}
                </p>
              )}
              <p>
                <b>PUBLIC FIRE</b> — every shot is seen by all: shooter, target, result.
                {config.pings && ' Pings, moves and decoys stay private. Sonar sweeps one board.'}
              </p>
              {config.specialTools && (
                <>
                  <p>
                    <b>SPECIALS</b> — all four arm when you lose your first ship; each sits out{' '}
                    {TOOL_COOLDOWN} of your turns after use.
                  </p>
                  {SPECIAL_TOOLS.map((id) => (
                    <p key={id}>
                      <b>{id} · {toolCost(id)} AP</b> — {TOOL_BRIEF[id]}
                    </p>
                  ))}
                </>
              )}
            </>
          ) : (
            <p>Sink all five enemy ships to win. Draw at turn {maxTurnsFor(seats)}.</p>
          )}
        </div>
      )}
    </div>
  );
}
