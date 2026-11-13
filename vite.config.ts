import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// Where finished games land. One JSON file per game, straight out of the
// browser — point a training script at the folder and read it.
const REPLAY_DIR = resolve(process.cwd(), 'replays');

// Filename built from scratch out of a whitelist, never from the posted string:
// this writes to disk on a request the page controls.
function replayFileName(game: { savedAt?: unknown; preset?: unknown; seed?: unknown }): string {
  const clean = (v: unknown, fallback: string) =>
    typeof v === 'string' || typeof v === 'number'
      ? String(v).replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 48) || fallback
      : fallback;
  return `${clean(game.savedAt, 'undated')}-${clean(game.preset, 'unknown')}-seed${clean(game.seed, '0')}.json`;
}

// Dev-only sink for the trajectory corpus: the app POSTs each finished game and
// it lands in replays/. The deployed build has no server behind it, so the fetch
// there just fails and the IndexedDB archive stays the fallback.
function replaySink(): Plugin {
  return {
    name: 'flotilla-replay-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST' || !req.url?.split('?')[0]?.endsWith('/__replay')) return next();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const game = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            mkdirSync(REPLAY_DIR, { recursive: true });
            writeFileSync(resolve(REPLAY_DIR, replayFileName(game)), JSON.stringify(game));
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  // Deployed as a GitHub Pages project site at dnl-strnl.github.io/flotilla/.
  base: '/flotilla/',
  define: {
    // Single source of truth for the app version is package.json.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react(), replaySink()],
  server: {
    port: 1775, // the year the Continental Navy was founded.
    strictPort: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Deferred behavior lab: its test stays on disk with it, untracked.
    exclude: ['tests/lab-trace.test.ts', 'node_modules/**'],
    environment: 'node',
  },
});
