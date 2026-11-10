import {
  createGame,
  mulberry32,
  step,
  PRESETS,
  type Action,
  type GameConfig,
  type GameState,
  type MoveDir,
  type ShipPlacement,
  type StepResult,
} from '../src/engine';

// Canonical test fleet, all horizontal at col 0: carrier 0..4, battleship 20..23,
// cruiser 40..42, submarine 60..62, destroyer 80..81.
export const TEST_FLEET: ShipPlacement[] = [
  { kind: 'carrier', origin: 0, orient: 'H' },
  { kind: 'battleship', origin: 20, orient: 'H' },
  { kind: 'cruiser', origin: 40, orient: 'H' },
  { kind: 'submarine', origin: 60, orient: 'H' },
  { kind: 'destroyer', origin: 80, orient: 'H' },
];

export function newGame(config: GameConfig = PRESETS.FLOTILLA, seed = 42): GameState {
  return createGame(config, [structuredClone(TEST_FLEET), structuredClone(TEST_FLEET)], seed);
}

const rng = mulberry32(123);

export function doStep(state: GameState, action: Action): StepResult {
  return step(state, action, rng);
}

// Apply a sequence of actions, returning final state and all events.
export function run(state: GameState, actions: Action[]): StepResult {
  let s = state;
  const events = [];
  for (const a of actions) {
    const r = doStep(s, a);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

export const shot = (cell: number): Action => ({ type: 'FIRE', cell });
export const ping = (center: number): Action => ({ type: 'PING', center });
export const move = (ship: number, dir: MoveDir): Action => ({ type: 'MOVE', ship, dir });
export const decoy = (cell: number): Action => ({ type: 'DECOY', cell });
export const pass: Action = { type: 'PASS' };

// Per-shooter views of the global shot log on GameState.
export const shotsBy = (state: GameState, seat: number) =>
  state.shots.filter((s) => s.by === seat);
export const sunkBy = (state: GameState, seat: number) =>
  state.shots.filter((s) => s.by === seat && s.result === 'SUNK').map((s) => s.sunkShip!);
