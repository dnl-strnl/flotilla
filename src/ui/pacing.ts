import type { Event } from '../engine';

// CPU playback pacing (jitter + post-result breath). Timing only; never read by
// engine/bots/replay. Breath values track the cue offsets in sfx/cues.ts (result 260ms
// after the gun, ping answer 420ms) — shorter would talk over them.

// Longer pause when the human's turn just ended, so the CPU doesn't jump in abruptly.
export const HANDOFF_BREATH_MS = 1400;

// Extra settle time after the action the event describes, in ms.
function breathAfter(event: Event | undefined, handoff: boolean): number {
  if (!event) return 0;
  switch (event.type) {
    case 'fire':
      return event.reported === 'SUNK' ? 900 : 420;
    case 'ping':
    // A sweep is a sweep: the answer lands on the same beat whichever tool asked.
    case 'scan':
    case 'echo':
      return 520;
    case 'decoyPlaced':
      return 260;
    // A flip pushes turnEnded THEN turnStarted, so turnStarted is the tail event
    // at every boundary — this is the between-turns pause ("sizing up the board").
    case 'turnStarted':
      return handoff ? HANDOFF_BREATH_MS : 750;
    case 'turnEnded':
      return 500;
    default:
      return 0;
  }
}

export const CPU_JITTER = { min: 0.6, max: 1.55 } as const;

// Occasional long hesitation: chance per gap, extra time as a multiple of base.
export const CPU_THINK = { chance: 0.18, min: 0.7, max: 1.8 } as const;

// Delay before the CPU's next micro-action. `base` = screen's nominal pace (spectate
// slider, or 400ms in-game); rand injected for testability; `handoff` = the boundary at the
// tail is a human turn ending (caller knows the bots).
export function cpuDelayMs(base: number, events: Event[], rand: () => number, handoff = false): number {
  const jitter = CPU_JITTER.min + rand() * (CPU_JITTER.max - CPU_JITTER.min);
  // Rare stretch past the jitter band: reads as weighing a decision, not a stall.
  const think =
    rand() < CPU_THINK.chance ? base * (CPU_THINK.min + rand() * (CPU_THINK.max - CPU_THINK.min)) : 0;
  // Breath scales with pace: at 60ms/action you want the shape, not the half-second.
  const breath = breathAfter(events[events.length - 1], handoff) * Math.min(1, base / 400);
  return Math.max(80, Math.round(base * jitter + think + breath));
}
