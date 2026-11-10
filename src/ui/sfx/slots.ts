// Sound slots: one id per distinguishable moment. Audio must not leak what the game hides:
// `fire.hit` covers decoy fakes; `enemy.activity` covers PING/MOVE/DECOY alike.
export const SLOT_IDS = [
  'ui.hover',
  'ui.click',
  'ui.back',
  'ui.toggle',
  'game.start',
  'ship.pickup',
  'ship.rotate',
  'ship.place',
  'ship.invalid',
  'fleet.random',
  'fleet.ready',
  'fire.send',
  'fire.hit',
  'fire.miss',
  'fire.sunk.enemy',
  'fire.sunk.own',
  'ping.send',
  'ping.positive',
  'ping.negative',
  'move.ship',
  'decoy.deploy',
  'ap.spend',
  'ap.insufficient',
  'tool.autoswitch',
  'turn.start',
  'turn.end',
  'enemy.activity',
  'end.victory',
  'end.defeat',
  'end.draw',
] as const;

export type Cue = (typeof SLOT_IDS)[number];

// A cue plus how long after the triggering state change it should fire.
export interface Beat {
  cue: Cue;
  // ms offset; the result of a shot lands after the gun, not with it.
  at: number;
  // Multiplier on the slot's gain (board hover = menu hover's tick, 100× as often). Default
  // 1.
  gain?: number;
  // false for cues designed to fire in rapid streams (hover), exempting them from ducking.
  duck?: boolean;
}

// Quiet a fast-repeating cue: floor volume back-to-back, linear recovery to full over
// `restMs` rest. Human pacing never notices the duck exists.
export function duckRepeat(elapsedMs: number, restMs = 900, floor = 0.35): number {
  if (elapsedMs >= restMs) return 1;
  if (elapsedMs <= 0) return floor;
  return floor + (1 - floor) * (elapsedMs / restMs);
}

// Pick a take for a multi-take slot, never the same one twice in a row (uniform random
// repeats 1-in-N). `last` = previous index, or -1.
export function pickVariant(count: number, last: number, rand: () => number): number {
  if (count <= 1) return 0;
  if (last < 0 || last >= count) return Math.min(count - 1, Math.floor(rand() * count));
  // Draw from the other takes only, then map back around the excluded index.
  const i = Math.min(count - 2, Math.floor(rand() * (count - 1)));
  return i >= last ? i + 1 : i;
}
