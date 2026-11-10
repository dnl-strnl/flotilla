import type { PlayerId } from './types';

// Seat order: fixed round-robin, seat (firstPlayer + turn - 1) % N. The constant N-1 enemy
// turns between a seat's turns is what lets the melee adapter rebuild an exact two-player
// clock. A destroyed fleet keeps its slot — see nextLiveTurn.
export function activePlayerFor(
  turn: number,
  playerCount: number,
  firstPlayer: PlayerId,
): PlayerId {
  return ((firstPlayer + turn - 1) % playerCount) as PlayerId;
}

// The next turn number that someone actually alive is due to take, searching forward from
// `fromTurn`. Null means the turn cap arrived first. A dead seat forfeits its slot rather
// than closing the rotation up, so survivors' turns stay exactly N apart.
export function nextLiveTurn(
  fromTurn: number,
  alive: readonly boolean[],
  firstPlayer: PlayerId,
  maxTurn: number,
): { turn: number; seat: PlayerId } | null {
  for (let turn = fromTurn + 1; turn <= maxTurn; turn++) {
    const seat = activePlayerFor(turn, alive.length, firstPlayer);
    if (alive[seat]) return { turn, seat };
  }
  return null;
}
