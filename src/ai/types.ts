import type { Action, Observation, RNG } from '../engine';

// A CPU opponent: a pure function of (redacted observation, legal action ids, rng) → one
// micro-action. Bots never see GameState; the returned action MUST be legal (step()
// enforces).
export type Bot = (obs: Observation, legal: number[], rng: RNG) => Action;

// Ascending naval rank, the ladder the README documents.
export type BotName = 'ensign' | 'lieutenant' | 'commander' | 'captain' | 'commodore' | 'admiral';
