import {
  FLEET,
  WAKE_SNIFF_TURNS,
  cellLabel,
  cellsFor,
  fitsOnBoard,
  shipCells,
  toCell,
  toRC,
  type GameState,
  type Observation,
  type Orient,
  type PingRecord,
  type PlayerId,
  type PlayerState,
  type ShipKind,
  type ShotRecord,
} from '../engine';
import { latestShotByCell } from '../ai';
import type { CellView } from './components/Board';
import { SHIP_LABEL } from './format';

// Turns for ping intel to go fully cold (red → orange → yellow → green → blue).
export const PING_DECAY_STEPS = 10;

// Hue of a ping overlay by age in turns: 0 (red) when fresh, 220 (blue) once cold.
export function pingHue(age: number): number {
  const t = Math.min(Math.max(age, 0), PING_DECAY_STEPS - 1) / (PING_DECAY_STEPS - 1);
  return Math.round(220 * t);
}

// Freshness of a ping overlay: 1 = this turn, fading toward a floor as it ages. The floor
// stays high enough that a cold (blue) wash is still legible.
export function pingFreshness(age: number): number {
  return Math.max(0.4, 1 - age / 16);
}

// Wash strength of one ping at `turn`: contacts glow, empty scans stay faint.
function pingAlpha(ping: PingRecord, turn: number): number {
  return pingFreshness(turn - ping.turn) * (ping.contact ? 0.55 : 0.18);
}

// Classic wash (hue decay off): flat amber, steeper fade, newest ping wins.
export function classicPingOpacity(ping: PingRecord, turn: number): number {
  const age = turn - ping.turn;
  return Math.max(0.12, 1 - age / 8) * (ping.contact ? 0.55 : 0.18);
}

// Blend the pings covering one cell into a single wash. Hue is the strength-weighted
// average of each ping's age hue, so a fresh contact over a stale scan reads warm; opacity
// composites so stacked intel reads denser.
export function blendPingWash(
  pings: PingRecord[],
  turn: number,
): { color: string; opacity: number } {
  let hueSum = 0;
  let weight = 0;
  let transparency = 1;
  for (const p of pings) {
    const alpha = pingAlpha(p, turn);
    hueSum += pingHue(turn - p.turn) * alpha;
    weight += alpha;
    transparency *= 1 - alpha;
  }
  return {
    color: `hsl(${Math.round(hueSum / weight)} 85% 55%)`,
    opacity: Math.min(0.65, 1 - transparency),
  };
}

// All pings covering each cell, oldest first (observation order).
function pingsPerCell(pings: PingRecord[]): Map<number, PingRecord[]> {
  const map = new Map<number, PingRecord[]>();
  for (const p of pings) {
    for (const c of p.cells) {
      const stack = map.get(c);
      if (stack) stack.push(p);
      else map.set(c, [p]);
    }
  }
  return map;
}

// One sweep, once: a public ECHO is filed by every seat that heard it, so pooled sonar
// would darken the wash by audience size. Turn + footprint + verdict finds the copies.
function dedupeSweeps(pings: PingRecord[]): PingRecord[] {
  const seen = new Set<string>();
  return pings.filter((p) => {
    const key = `${p.turn}:${p.center}:${p.cells.length}:${p.contact}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Perimeter-edge classes outlining a ship as one unit: cross-axis edges on every segment,
// along-axis edges only at the ends. `wreck` = red kill perimeter, `hull` = live ship.
function perimeterEdges(
  prefix: 'wreck' | 'hull',
  ship: { orient: Orient; length: number },
  segment: number,
): string {
  const [head, tail] = ship.orient === 'H' ? [`${prefix}-w`, `${prefix}-e`] : [`${prefix}-n`, `${prefix}-s`];
  const across = ship.orient === 'H' ? `${prefix}-n ${prefix}-s` : `${prefix}-w ${prefix}-e`;
  let edges = `${prefix} ${across}`;
  if (segment === 0) edges += ` ${head}`;
  if (segment === ship.length - 1) edges += ` ${tail}`;
  return edges;
}

function wreckEdges(ship: { orient: Orient; length: number }, segment: number): string {
  return perimeterEdges('wreck', ship, segment);
}

const SHIP_LENGTH = Object.fromEntries(FLEET.map((f) => [f.kind, f.length])) as Record<
  ShipKind,
  number
>;

// An enemy hull the viewer has confirmed destroyed, as their own intel pins it.
export interface SunkHull {
  kind: ShipKind;
  orient: Orient;
  cells: number[];
}

// Footprints of enemy ships the viewer sank, from the viewer's own intel only (no truth
// leak). Outlined only when the markers admit exactly ONE placement.
export function sunkEnemyHulls(shots: ShotRecord[]): SunkHull[] {
  const hulls: SunkHull[] = [];
  const claimed = new Set<number>();
  const struck = new Set<number>();

  // Chronological pass: each kill resolves against intel as it stood then, so
  // later shots can't retroactively widen a run and un-pin a placed wreck.
  for (const record of shots) {
    // Per-cell markers, newest wins: a MISS reopens a previously-hit cell.
    if (record.result === 'MISS') struck.delete(record.cell);
    else struck.add(record.cell);
    if (record.result !== 'SUNK' || !record.sunkShip) continue;

    const kind = record.sunkShip;
    const length = SHIP_LENGTH[kind];
    const { r, c } = toRC(record.cell);
    const options: SunkHull[] = [];
    for (const orient of ['H', 'V'] as const) {
      // Every placement putting the killing shot at some segment of the hull.
      for (let segment = 0; segment < length; segment++) {
        if (orient === 'H' ? c - segment < 0 : r - segment < 0) continue;
        const origin = orient === 'H' ? toCell(r, c - segment) : toCell(r - segment, c);
        if (!fitsOnBoard(origin, orient, length)) continue;
        const cells = cellsFor(origin, orient, length);
        if (cells.some((cell) => !struck.has(cell) || claimed.has(cell))) continue;
        options.push({ kind, orient, cells });
      }
    }
    if (options.length !== 1) continue;
    hulls.push(options[0]!);
    for (const cell of options[0]!.cells) claimed.add(cell);
  }
  return hulls;
}

// The player's own board: ships, damage, decoys, incoming fire. Also renders truth boards
// (game-over reveal / spectate) from any PlayerState-shaped trio.
export function ownBoardCells(
  obs: Pick<Observation, 'myShips' | 'myDecoys' | 'shotsAgainstMe'>,
): CellView[] {
  const cells: CellView[] = Array.from({ length: 100 }, () => ({}));
  const incoming = new Set(obs.shotsAgainstMe.map((s) => s.cell));

  for (const ship of obs.myShips) {
    shipCells(ship).forEach((cell, segment) => {
      const damaged = ship.hits[segment];
      let cls = ship.sunk ? 'own-ship sunk' : damaged ? 'own-ship damaged' : 'own-ship';
      // Hull perimeter keeps a footprint whole — else a ship sliding under a
      // spent decoy's ◆ loses its head cell and reads one segment short.
      cls += ` ${perimeterEdges(ship.sunk ? 'wreck' : 'hull', ship, segment)}`;
      cells[cell] = {
        classes: cls,
        title: ship.sunk
          ? `${SHIP_LABEL[ship.kind]} (SUNK) ${cellLabel(cell)}`
          : `${SHIP_LABEL[ship.kind]} ${cellLabel(cell)}`,
        glyph: damaged ? '✕' : undefined,
      };
    });
  }
  for (const decoy of obs.myDecoys) {
    const label = decoy.spent ? `DECOY (EXPENDED) ${cellLabel(decoy.cell)}` : `DECOY ${cellLabel(decoy.cell)}`;
    const under = cells[decoy.cell]!;
    // Ship sharing a decoy's cell wins the render; the decoy shrinks to a corner
    // tag — hiding the hull would redraw the deception this truth view exposes.
    cells[decoy.cell] = under.classes
      ? { ...under, tag: '◆', title: `${under.title} · ${label}` }
      : { classes: decoy.spent ? 'own-decoy spent' : 'own-decoy', glyph: '◆', title: label };
  }
  for (const cell of incoming) {
    const view = cells[cell]!;
    cells[cell] = { ...view, classes: `${view.classes ?? ''} incoming`.trim() };
  }
  return cells;
}

// Full-truth board for one seat (game-over reveal / spectate / replay).
export function truthBoardCells(ps: Pick<PlayerState, 'ships' | 'decoys' | 'shotsReceived'>): CellView[] {
  return ownBoardCells({ myShips: ps.ships, myDecoys: ps.decoys, shotsAgainstMe: ps.shotsReceived });
}

// Truth board (replay / observation deck): one seat's truth with the opponents' sonar
// washed over it, painted exactly like the live targeting grid.
export function truthBoardWithSonar(
  state: Pick<GameState, 'turn' | 'players'>,
  seat: PlayerId,
  pingHues = true,
  // Which seats' sonar to draw; omitted = all of them.
  from?: boolean[],
): CellView[] {
  const cells = truthBoardCells(state.players[seat]!);
  // Sonar drawn over this board is everyone ELSE's — at N=2 that is the one opponent.
  const pingAt = pingsPerCell(
    dedupeSweeps(
      state.players.flatMap((p, i) =>
        i === seat || from?.[i] === false ? [] : p.pings.filter((g) => (g.target ?? seat) === seat),
      ),
    ),
  );
  for (const [cell, stack] of pingAt) {
    const view = { ...cells[cell]! };
    const newest = stack[stack.length - 1]!;
    if (pingHues) {
      const wash = blendPingWash(stack, state.turn);
      view.pingOpacity = wash.opacity;
      view.pingColor = wash.color;
    } else {
      view.pingOpacity = classicPingOpacity(newest, state.turn);
    }
    if (newest.center === cell) {
      // Same quiet center marker as the live grid, but truth outranks intel:
      // never over a damage ✕ or a decoy's ◆.
      if (view.glyph === undefined) {
        view.glyph = newest.contact ? '▲' : '▽';
        view.classes = `${view.classes ?? ''} ${newest.contact ? 'ping-center contact' : 'ping-center'}`.trim();
      }
      if (view.tag === undefined) view.tag = `T${newest.turn}`;
    }
    cells[cell] = view;
  }
  return cells;
}

// Classes that only style a ping-center glyph; a shot marker over the cell must shed them.
// (wake-mark stays for its tint; app.css keeps its glyph size off shot cells.)
const GLYPH_CLASSES = new Set(['ping-center', 'contact']);

// The targeting grid: the viewer's intel about the enemy board.
export function enemyBoardCells(
  obs: Pick<Observation, 'turn' | 'myPings' | 'myShots' | 'enemyWakes'> & {
    me?: number;
    playerCount?: number;
  },
  lastShotCell: number | null,
  pingHues = true,
): CellView[] {
  const cells: CellView[] = Array.from({ length: 100 }, () => ({}));
  const pingAt = pingsPerCell(obs.myPings);
  const latest = latestShotByCell(obs.myShots);
  // Latest wake per cell (records are chronological; newest wins), fresh ones only.
  // A dredged mark lasts until my sniffing turn ends: as many slots as I sit after the
  // mover (one in a duel; one or two in MELEE, where `of` names the mover).
  const n = obs.playerCount ?? 2;
  const sniffWindow = (w: { of?: number }) =>
    w.of !== undefined && obs.me !== undefined ? (obs.me - w.of + n) % n : WAKE_SNIFF_TURNS;
  const wakeAt = new Map<number, number>(); // cell → turn of the wake
  for (const w of obs.enemyWakes) {
    if (obs.turn - w.turn > sniffWindow(w)) continue;
    for (const c of w.cells) wakeAt.set(c, w.turn);
  }

  for (let cell = 0; cell < 100; cell++) {
    const view: CellView = {};
    const stack = pingAt.get(cell);
    if (stack) {
      const newest = stack[stack.length - 1]!;
      if (pingHues) {
        const wash = blendPingWash(stack, obs.turn);
        view.pingOpacity = wash.opacity;
        view.pingColor = wash.color;
      } else {
        view.pingOpacity = classicPingOpacity(newest, obs.turn);
      }
      if (newest.center === cell) {
        // A quiet marker like the shot glyphs — a ring here reads as "selected".
        view.tag = `T${newest.turn}`;
        view.glyph = newest.contact ? '▲' : '▽';
        view.classes = newest.contact ? 'ping-center contact' : 'ping-center';
      }
    }
    const wakeTurn = wakeAt.get(cell);
    if (wakeTurn !== undefined) {
      // Vacated water: the enemy ship was here and left. Shot markers below
      // overwrite the glyph — a resolved cell outranks a trail.
      view.classes = `${view.classes ?? ''} wake-mark`.trim();
      view.glyph = '≈';
      view.title = `WAKE T${wakeTurn} — VACATED`;
    }
    const record = latest.get(cell);
    if (record) {
      // A shot replaces the sonar/wake glyph, so drop the classes that size it too —
      // else a ✕ on a ping center renders at 9px and reads as a different kind of hit.
      view.classes = view.classes
        ?.split(' ')
        .filter((c) => !GLYPH_CLASSES.has(c))
        .join(' ');
      if (record.result === 'MISS') {
        view.classes = `${view.classes ?? ''} fire-miss`.trim();
        view.glyph = '·';
        view.title = `MISS T${record.turn}`;
      } else {
        const sunk = record.result === 'SUNK';
        view.classes = `${view.classes ?? ''} fire-hit${sunk ? ' fire-sunk' : ''}`.trim();
        view.glyph = '✕';
        view.title = sunk ? `SUNK ${SHIP_LABEL[record.sunkShip!]} T${record.turn}` : `HIT T${record.turn}`;
      }
    }
    if (cell === lastShotCell) {
      view.classes = `${view.classes ?? ''} reticle`.trim();
    }
    cells[cell] = view;
  }

  // Outline each confirmed kill as one hull. Last, so the wreck perimeter wins
  // over the per-cell hit marks it replaces.
  for (const hull of sunkEnemyHulls(obs.myShots)) {
    hull.cells.forEach((cell, segment) => {
      const view = cells[cell]!;
      cells[cell] = {
        ...view,
        classes: `${view.classes ?? ''} enemy-wreck ${wreckEdges(
          { orient: hull.orient, length: hull.cells.length },
          segment,
        )}`.trim(),
        title: `${SHIP_LABEL[hull.kind]} (SUNK) ${cellLabel(cell)}`,
      };
    });
  }
  return cells;
}

