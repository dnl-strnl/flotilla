import { PASS_ID, FIRE_BASE, decodeAction, rngPick } from '../engine';
import type { Bot } from './types';

// ENSIGN — uniform over legal actions, mild shot preference. Never passes voluntarily (AP
// always decreases, so turns still terminate).
export const ensign: Bot = (_obs, legal, rng) => {
  const nonPass = legal.filter((id) => id !== PASS_ID);
  if (nonPass.length === 0) return { type: 'PASS' };
  const shots = nonPass.filter((id) => id >= FIRE_BASE && id < FIRE_BASE + 100);
  if (shots.length > 0 && rng() < 0.6) {
    return decodeAction(rngPick(rng, shots));
  }
  return decodeAction(rngPick(rng, nonPass));
};
