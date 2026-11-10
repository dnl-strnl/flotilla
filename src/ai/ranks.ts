import { ensign } from './ensign';
import { makeCommander } from './commander';
import { makeAdmiral } from './admiral';
import { makeCaptain } from './captain';
import { makeLieutenant } from './lieutenant';
import { makeCommodore } from './commodore';
import type { Bot, BotName } from './types';

export interface BotOptions {
  // Monte Carlo sample count for heatmap bots.
  samples?: number;
}

// Leaf module so the melee adapter can build ranks without importing ./index, which
// re-exports it.
export function makeBot(name: BotName, opts: BotOptions = {}): Bot {
  switch (name) {
    case 'ensign':
      return ensign;
    case 'commander':
      return makeCommander(opts.samples ?? 1000);
    case 'admiral':
      return makeAdmiral(opts.samples ?? 1000);
    case 'lieutenant':
      return makeLieutenant(opts.samples ?? 1000);
    case 'captain':
      return makeCaptain(opts.samples ?? 1000);
    case 'commodore':
      return makeCommodore(opts.samples ?? 1000);
  }
}
