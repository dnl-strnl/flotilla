import type { PlayerId, PresetName, Replay } from '../engine';
import type { BotName } from '../ai';

// Every finished game is archived as a replay plus filter metadata (incl. app version,
// since rules shift between versions). Sinks: replays/ on disk in dev, and IndexedDB —
// not localStorage, whose ~5MB ceiling would cap the corpus at a few hundred games.

const DB_NAME = 'flotilla-archive';
const DB_VERSION = 1;
const STORE = 'replays';

export interface ArchiveMeta {
  // Seconds-resolution ISO stamp of when the game finished.
  savedAt: string;
  appVersion: string;
  preset: PresetName;
  // Bot per seat; null = a human held it.
  bots: (BotName | null)[];
  // The seat YOU played, or null for a bot-vs-bot exhibition.
  humanSeat: PlayerId | null;
  outcome: 'win' | 'loss' | 'draw' | 'bot-win' | 'bot-draw';
  winner: PlayerId | null;
  byForfeit: boolean;
  turns: number;
  seed: number;
  // Micro-actions in the game — the corpus's real unit of size.
  actionCount: number;
}

export interface ArchivedGame extends ArchiveMeta {
  id?: number;
  replay: Replay;
}

// Failures resolve to null, never throw: private-mode browsers reject open() outright.
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

export async function archiveGame(game: ArchivedGame): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(game);
    tx.oncomplete = () => {
      db.close();
      resolve(true);
    };
    tx.onerror = () => {
      db.close();
      resolve(false);
    };
  });
}

export async function archiveCount(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => {
      db.close();
      resolve(req.result);
    };
    req.onerror = () => {
      db.close();
      resolve(0);
    };
  });
}

// Dev only: POST to the Vite dev server (replaySink in vite.config.ts), which writes it
// into replays/. Failure is silent by design.
export async function saveGameToDisk(game: ArchivedGame): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    await fetch(`${import.meta.env.BASE_URL}__replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(game),
    });
  } catch {
    // Dev server gone; nothing to tell the player.
  }
}
