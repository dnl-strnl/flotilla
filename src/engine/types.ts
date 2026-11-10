// Core engine types. Everything here is plain JSON-serializable data:
// no classes, no Maps/Sets, no functions inside state.

export const BOARD_SIZE = 10;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
// Two-player draw cap: 201 turns ≈ 100 rounds each. See maxTurnsFor for N players.
export const MAX_TURNS = 201;

// Hard draw cap for an N-player game: 100 rounds each, plus the odd opening turn.
export function maxTurnsFor(playerCount: number): number {
  return 1 + 100 * playerCount;
}
// Seats a game may hold. 2 = the classic duel, 3 = MELEE; the extra headroom keeps
// the action encoding bounded (see decodeAction) rather than open-ended.
export const MAX_PLAYERS = 4;
export const MAX_DECOYS = 2;
export type ToolId = 'SCAN' | 'ECHO' | 'FORK' | 'SPRAY';

// SPECIAL TOOLS — MELEE only. The whole kit arms when a fleet loses its first ship
// (see toolsUnlocked); each is then reusable after TOOL_COOLDOWN of its owner's turns.
// Array order is not display order (that is SPECIAL_RANK in ui/state.ts).
export const TOOLS: ReadonlyArray<{ id: ToolId; cost: number }> = [
  { id: 'SCAN', cost: 1 },
  { id: 'ECHO', cost: 1 },
  { id: 'FORK', cost: 2 },
  { id: 'SPRAY', cost: 4 },
];

export function toolCost(tool: ToolId): number {
  return TOOLS.find((t) => t.id === tool)!.cost;
}

// Own turns a tool sits out after use: fired on your turn 10, ready again on your turn 13.
// Tuning knob.
export const TOOL_COOLDOWN = 3;

// Owner's turns a tool still has to wait as of their next (or current) turn; 0 = ready.
// Exact because dead seats keep their slot, so the owner's turns are always N apart.
export function toolCooldownLeft(lastUsed: number | undefined, turn: number, playerCount: number): number {
  if (lastUsed === undefined) return 0;
  return Math.max(0, TOOL_COOLDOWN - Math.ceil((turn - lastUsed) / playerCount));
}

// SCAN: a private 2×2 close look (top-left anchor) that marks exactly which cells answer.
export const SCAN_SIZE = 2;
// ECHO: a public 4×4 sweep (top-left anchor) that reports how many cells answer.
export const ECHO_SIZE = 4;
export const AP_CAP = 5;
// Per-turn AP floor = one shot, so a one-ship player can always fire. Tuning knob.
export const AP_FLOOR = 2;

// Cell index 0..99; idx = row * 10 + col.
export type Cell = number;

export type Orient = 'H' | 'V';

// One-cell translation, orientation kept. Array index = action-encoding offset.
export type MoveDir = 'N' | 'S' | 'W' | 'E';
export const MOVE_DIRS: readonly MoveDir[] = ['N', 'S', 'W', 'E'];
export const MOVE_DELTA: Record<MoveDir, { dr: number; dc: number }> = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  W: { dr: 0, dc: -1 },
  E: { dr: 0, dc: 1 },
};
// Seat index 0..playerCount-1. Two-player games use 0 and 1; MELEE adds seat 2.
export type PlayerId = number;

export type ShipKind =
  | 'carrier'
  | 'battleship'
  | 'cruiser'
  | 'submarine'
  | 'destroyer';

// Canonical fleet order. Ship index 0..4 in GameState/MOVE actions follows this order.
export const FLEET: ReadonlyArray<{ kind: ShipKind; length: number }> = [
  { kind: 'carrier', length: 5 },
  { kind: 'battleship', length: 4 },
  { kind: 'cruiser', length: 3 },
  { kind: 'submarine', length: 3 },
  { kind: 'destroyer', length: 2 },
];

export const AP_COST = {
  FIRE: 2,
  PING: 1,
  MOVE: 2,
  DECOY: 3,
  PASS: 0,
} as const;

// Side of the spray block. 2 = the 2×2 that ships.
export const SPRAY_SIZE = 2;

// Price of every PING after a turn's first, under `pingEscalates`. See pingCostFor.
export const PING_ESCALATED_COST = 2;

// A MOVE's latent wake answers sonar for this many rounds after the move (turn − wakeTurn ≤
// WAKE_SNIFF_TURNS × seats): in a duel, solely on the opponent's next turn — the water
// smooths over before their next chance.
export const WAKE_SNIFF_TURNS = 1;

export interface GameConfig {
  salvoBudget: boolean;
  movement: boolean;
  pings: boolean;
  decoys: boolean;
  // Variant: a turn's first PING costs AP_COST.PING, each further one PING_ESCALATED_COST,
  // counted per turn across all boards. MELEE only; flat at two seats. Tuning knob.
  pingEscalates: boolean;
  // Rule: once MELEE narrows to two fleets, both survivors play every remaining turn
  // at AP_CAP, so a lone dodging hull can be hunted down. Never applies to two-seat games.
  finalDuelFullAp: boolean;
  // Rule: the SPECIAL TOOLS kit can arm. Still needs three or more seats.
  specialTools: boolean;
  // Rule: while three or more fleets are afloat every one plays at AP_CAP, losses or not.
  meleeFullAp: boolean;
}

// AP price of the NEXT PING this turn, given the sweeps already bought. Flat at two seats
// whatever the flag says (see GameConfig.pingEscalates).
export function pingCostFor(config: GameConfig, playerCount: number, pingsThisTurn: number): number {
  if (!config.pingEscalates || playerCount < 3 || pingsThisTurn === 0) return AP_COST.PING;
  return PING_ESCALATED_COST;
}

export type PresetName = 'CLASSIC' | 'SALVO' | 'FLOTILLA';

export const PRESETS: Record<PresetName, GameConfig> = {
  CLASSIC: { salvoBudget: false, movement: false, pings: false, decoys: false, pingEscalates: false, finalDuelFullAp: false, specialTools: false, meleeFullAp: false },
  SALVO: { salvoBudget: true, movement: false, pings: false, decoys: false, pingEscalates: false, finalDuelFullAp: false, specialTools: false, meleeFullAp: false },
  FLOTILLA: { salvoBudget: true, movement: true, pings: true, decoys: true, pingEscalates: false, finalDuelFullAp: true, specialTools: true, meleeFullAp: true },
};

export interface Ship {
  kind: ShipKind;
  length: number;
  // Head cell; body extends toward +col (H) or +row (V).
  origin: Cell;
  orient: Orient;
  // Per-segment damage, index 0 = origin.
  hits: boolean[];
  sunk: boolean;
}

// Placement input to createGame — a Ship without damage bookkeeping.
export interface ShipPlacement {
  kind: ShipKind;
  origin: Cell;
  orient: Orient;
}

export interface Decoy {
  cell: Cell;
  // True once it has absorbed its fake HIT; a spent decoy is inert and invisible.
  spent: boolean;
}

// Result as REPORTED to the shooter (a decoy fake-hit is stored as 'HIT').
export type ShotResult = 'HIT' | 'MISS' | 'SUNK';

export interface ShotRecord {
  cell: Cell;
  result: ShotResult;
  turn: number;
  // Ship identity, revealed only on SUNK.
  sunkShip?: ShipKind;
  // Set only inside TargetIntel.shots, which pools every seat's fire at one board. Absent
  // in the flat two-player views, where every record is the viewer's own.
  by?: PlayerId;
}

export interface PingRecord {
  center: Cell;
  // Cells actually scanned (clipped at edges).
  cells: Cell[];
  contact: boolean;
  // ECHO only: OCCUPANCY, how many of `cells` answered (live ship segments plus decoys).
  occupancy?: number;
  turn: number;
  // Which enemy board this sweep was pointed at. Sonar names one fleet, so a contact is
  // never ambiguous about whose it is. Absent = the sole opponent (two-player games).
  target?: PlayerId;
}

export interface IncomingShot {
  cell: Cell;
  turn: number;
  // Who fired it. Absent in two-player games, where the only candidate is the one
  // opponent and recording it would change long-settled observations for no gain.
  by?: PlayerId;
}

// Cells an enemy ship vacated by MOVEing — the subset sonar dredged up. `turn` is always
// the MOVE's turn, not the reveal's.
export interface WakeRecord {
  cells: Cell[];
  turn: number;
  // Whose ship left this trail. Absent = the sole opponent (two-player games).
  of?: PlayerId;
}

// One shot, as it really happened. Lives on GameState, not PlayerState: shot RESULTS are
// public to every seat (only the shooter's identity is withheld — see redactEventsFor), so
// a single log is the one source of truth. Per-side views are derived in observe().
export interface ShotLogEntry {
  by: PlayerId;
  target: PlayerId;
  cell: Cell;
  result: ShotResult;
  turn: number;
  // Ship identity, revealed only on SUNK.
  sunkShip?: ShipKind;
}

export interface PlayerState {
  ships: Ship[];
  decoys: Decoy[];
  // Total decoys placed this game (spent ones included), 0..MAX_DECOYS.
  decoysPlaced: number;
  // Turn each special tool was last fired; absent = never. Drives the cooldown (see
  // toolCooldownLeft).
  toolLastUsed: Partial<Record<ToolId, number>>;
  pings: PingRecord[];
  // Wakes of opponent moves, as my sonar dredged them up.
  wakes: WakeRecord[];
  // Latent wakes MY OWN moves left behind. Engine-private bookkeeping, shown to neither
  // side: an opponent PING dredges the fresh, swept subset into THEIR `wakes` (see
  // WAKE_SNIFF_TURNS).
  wakeTrail: WakeRecord[];
  // Where I have been fired at (always visible to me). Carries no attacker id: under OPEN
  // WATER's anonymous fire you genuinely cannot tell which enemy shot you.
  shotsReceived: IncomingShot[];
}

// At least two fleets. A variadic tuple so seats 0 and 1 stay non-optional under
// noUncheckedIndexedAccess; only a third seat needs a presence check.
export type AtLeastTwo<T> = [T, T, ...T[]];

export type Phase =
  | { kind: 'playing' }
  // `byForfeit`: the loser struck their colors (forfeit()) rather than losing their fleet.
  // `eliminated`: the LAST fleet to go down; fleetEliminated events hold the full list.
  | { kind: 'won'; winner: PlayerId; byForfeit?: true; eliminated?: PlayerId }
  | { kind: 'draw' };

// One seat's surviving force, what end-screen standings rank on (not a win condition).
export interface Force {
  squares: number;
  ships: number;
}

export interface GameState {
  config: GameConfig;
  // Recorded with every replay. Seat order comes from firstPlayer, not from this.
  seed: number;
  // Who opened the game, and the head of the round-robin at every seat count.
  firstPlayer: PlayerId;
  // 1-based; increments on every turn flip. round = floor((turn-1)/N), seat position within
  // it = (turn-1) % N.
  turn: number;
  // Derived, never chosen: seats take turns in a fixed round-robin from firstPlayer (see
  // order.ts). Stored for convenience only.
  activePlayer: PlayerId;
  // AP remaining for the active player this turn.
  ap: number;
  // AP granted at this turn's start.
  budget: number;
  // Ship indices the active player has moved this turn (max one move per ship per turn).
  movedShips: number[];
  // Sweeps the active player has already bought this turn, across every enemy board.
  // Consulted only under `pingEscalates` (see pingCostFor); reset at every handoff.
  pingsThisTurn: number;
  players: AtLeastTwo<PlayerState>;
  // Every shot of the game, in order. Public intel once redacted (see ShotLogEntry).
  shots: ShotLogEntry[];
  phase: Phase;
}

// `at` on FIRE/PING is a RELATIVE opponent offset, 1..N-1: the defender is
// (me + at) % N. Absent = 1 = the next seat, which is the only opponent at N=2 — so
// two-player actions, their encodings and their replay JSON are unchanged.
export type Action =
  | { type: 'FIRE'; cell: Cell; at?: number }
  | { type: 'PING'; center: Cell; at?: number }
  // SPECIAL TOOLS (see TOOLS), MELEE only. Block tools anchor `cell` at the TOP-LEFT.
  // SPRAY: 2×2 damage block.
  | { type: 'SPRAY'; cell: Cell; at?: number }
  // FORK: one cell, fired into EVERY enemy board at once. Names no target.
  | { type: 'FORK'; cell: Cell }
  // SCAN: a private 2×2 sweep.
  | { type: 'SCAN'; cell: Cell; at?: number }
  // ECHO: a 4×4 sweep whose result is PUBLIC to every seat.
  | { type: 'ECHO'; cell: Cell; at?: number }
  | { type: 'MOVE'; ship: number; dir: MoveDir }
  | { type: 'DECOY'; cell: Cell }
  | { type: 'PASS' };

// Events carry full truth for replays; redactEventsFor() filters per side. "Private" fields
// leak defender secrets and must never reach the attacker.
export type Event =
  | { type: 'turnStarted'; turn: number; player: PlayerId; budget: number }
  | {
      type: 'fire';
      turn: number;
      by: PlayerId;
      // Whose board was fired at. Both ends of a shot are public: every seat sees who fired
      // at whom, and only the defender's private truth below is withheld.
      target: PlayerId;
      cell: Cell;
      // What the shooter is told.
      reported: ShotResult;
      // Private: true ship identity on a real hit.
      hitShip?: ShipKind;
      // Public on sink: identity. Cells are private (defender UI / replay only) and
      // stripped by redaction.
      sunkShip?: { kind: ShipKind; cells?: Cell[] };
      // Private: this "HIT" was a decoy's fake hit.
      decoy?: boolean;
      // This shell was one cell of a spray. Public: a 2×2 landing at once is loud, and the
      // defender can count the craters anyway.
      spray?: true;
    }
  // `wakes`: fresh enemy wakes this sweep dredged up, clipped to the
  // scanned cells. Safe: the wake's owner only ever sees this ping as `enemyActivity`.
  | { type: 'ping'; turn: number; by: PlayerId; target: PlayerId; center: Cell; cells: Cell[]; contact: boolean; wakes?: WakeRecord[] }
  | { type: 'move'; turn: number; player: PlayerId; ship: number; dir: MoveDir; from: Cell; to: Cell }
  | { type: 'decoyPlaced'; turn: number; player: PlayerId; cell: Cell }
  | { type: 'decoySpent'; turn: number; player: PlayerId; cell: Cell }
  // A tight 2×2 sweep. Private to the scanner, like a ping.
  | { type: 'scan'; turn: number; by: PlayerId; target: PlayerId; cell: Cell; cells: Cell[]; contact: boolean; live: Cell[] }
  // ECHO. Public at every end: who lit whom, where, and what came back. Redaction passes
  // it through untouched to every seat, which is the whole point of the tool.
  | { type: 'echo'; turn: number; by: PlayerId; target: PlayerId; cells: Cell[]; contact: boolean; occupancy: number }
  // This fleet lost its first ship, so its whole special kit just armed. One event, not
  // one per tool — they all arrive together. Private to the owner.
  | { type: 'toolUnlocked'; turn: number; player: PlayerId }
  // A fleet's last hull went down. MELEE only (in a duel gameOver says it). Public.
  | { type: 'fleetEliminated'; turn: number; player: PlayerId; by: PlayerId }
  | { type: 'passed'; turn: number; player: PlayerId }
  | { type: 'turnEnded'; turn: number; player: PlayerId; reason: 'pass' | 'exhausted' }
  // `forfeit`: present when the game ended by concession — the player who struck colors.
  | {
      type: 'gameOver';
      turn: number;
      result: 'win' | 'draw';
      winner?: PlayerId;
      forfeit?: PlayerId;
      // The fleet whose destruction left one survivor — absent on a draw or a forfeit.
      eliminated?: PlayerId;
    }
  // Redaction-only, never emitted by step(): stands in for an opponent's private
  // ping/move/decoy — "AP spent on something". See tempo note in observe.ts.
  | { type: 'enemyActivity'; turn: number; player: PlayerId };

export interface StepResult {
  state: GameState;
  events: Event[];
}

// Everything one seat knows about ONE enemy board. `shots` carries every seat's fire at
// that board (damage is public) with the shooters stripped (fire is anonymous).
export interface TargetIntel {
  shots: ShotRecord[];
  pings: PingRecord[];
  wakes: WakeRecord[];
  sunk: ShipKind[];
  shipsRemaining: number;
}

// The redacted view a bot (or the UI for one side) is allowed to see.
export interface Observation {
  config: GameConfig;
  me: PlayerId;
  playerCount: number;
  turn: number;
  ap: number;
  budget: number;
  // What the NEXT sweep costs me right now — not a constant under `pingEscalates`, so bots
  // must price sonar off this rather than off AP_COST.PING. 0 when it is not my turn.
  pingCost: number;
  movedShips: number[];
  myShips: Ship[];
  myDecoys: Decoy[];
  myDecoysLeft: number;
  // Own turns each special tool still has to cool down, 0 = ready once the locker is open
  // (see toolsUnlocked). Mine alone — what a rival has cooling is not public.
  myToolCooldowns: Record<ToolId, number>;
  myHullDown: number;
  shotsAgainstMe: IncomingShot[];
  myShots: ShotRecord[];
  myPings: PingRecord[];
  // Vacated cells of enemy moves, as my sonar dredged them up.
  enemyWakes: WakeRecord[];
  enemySunk: ShipKind[];
  enemyShipsRemaining: number;
  // Per-seat intel, indexed by PlayerId; null at my own seat. The five enemy* fields above
  // are this same data for the NEXT seat (the two-player view).
  intel: (TargetIntel | null)[];
}

// Uniform [0, 1). All engine/bot randomness flows through this.
export type RNG = () => number;
