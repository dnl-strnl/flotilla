import { duckRepeat, pickVariant, type Beat, type Cue } from './slots';

// The only audio code that touches the world; decides nothing, obeys beats from cues.ts.
// Web Audio (not <audio>) for drift-free offsets and self-overlap.

// One recording of a cue. A slot holds one or more; see pickVariant().
interface Variant {
  src: string;
  // Per-file trim, so one loud pack doesn't tower over a quiet one.
  gain?: number;
  // Fade to silence from this ms offset (for a take that overstays its moment).
  fadeAfterMs?: number;
  // How long the fade lasts. Only read alongside fadeAfterMs; default 300.
  fadeOverMs?: number;
}
type Manifest = Partial<Record<Cue, Variant[]>>;

interface Take {
  buffer: AudioBuffer;
  gain: number;
  fadeAfterMs?: number;
  fadeOverMs?: number;
}

const LS_VOL = 'flotilla-sfx-volume';
const LS_MUTE = 'flotilla-sfx-muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let manifest: Manifest = {};
const takes = new Map<Cue, Take[]>();
// Last variant played per cue, so a rotation never repeats back to back.
const lastTake = new Map<Cue, number>();
// When each cue last started (context time), for repetition ducking.
const lastStart = new Map<Cue, number>();

// First visit starts quiet; a level the player sets is remembered from then on.
const DEFAULT_VOLUME = 0.25;
let volume = Number(localStorage.getItem(LS_VOL) ?? DEFAULT_VOLUME);
let muted = localStorage.getItem(LS_MUTE) === '1';

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);
  return ctx;
}

// Fetch + decode every mapped sound up front; an unmapped slot is silent, not an error.
// Manifest srcs are root-absolute but public/ is served under Vite's base (/flotilla/).
const withBase = (path: string) => import.meta.env.BASE_URL.replace(/\/$/, '') + path;

export async function initSfx(url = withBase('/sfx/manifest.json')): Promise<void> {
  const audio = ensureContext();
  if (!audio) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    manifest = (await res.json()) as Manifest;
  } catch {
    return;
  }
  await Promise.all(
    (Object.entries(manifest) as [Cue, Variant[]][]).map(async ([cue, variants]) => {
      const decoded: Take[] = [];
      for (const variant of variants) {
        try {
          const bytes = await (await fetch(withBase(variant.src))).arrayBuffer();
          decoded.push({
            buffer: await audio.decodeAudioData(bytes),
            gain: variant.gain ?? 1,
            fadeAfterMs: variant.fadeAfterMs,
            fadeOverMs: variant.fadeOverMs,
          });
        } catch {
          // one bad file stays silent; the rest of the slot still plays
        }
      }
      if (decoded.length) takes.set(cue, decoded);
    }),
  );
}

// Browsers hold the context suspended until a gesture. Call on first input.
export function unlockSfx(): void {
  const audio = ensureContext();
  if (audio && audio.state === 'suspended') void audio.resume();
}

export function playBeats(beats: Beat[]): void {
  if (!beats.length || muted) return;
  const audio = ensureContext();
  if (!audio || !master || audio.state !== 'running') return;
  for (const beat of beats) {
    const slot = takes.get(beat.cue);
    if (!slot) continue;
    const index = pickVariant(slot.length, lastTake.get(beat.cue) ?? -1, Math.random);
    lastTake.set(beat.cue, index);
    const take = slot[index]!;
    const source = audio.createBufferSource();
    source.buffer = take.buffer;
    const trim = audio.createGain();
    const startAt = audio.currentTime + beat.at / 1000;
    let duck = 1;
    if (beat.duck !== false) {
      const prevStart = lastStart.get(beat.cue);
      if (prevStart !== undefined) duck = duckRepeat((startAt - prevStart) * 1000);
      lastStart.set(beat.cue, startAt);
    }
    const level = take.gain * (beat.gain ?? 1) * duck;
    trim.gain.value = level;
    source.connect(trim).connect(master);
    // start() must precede stop(): Web Audio throws InvalidStateError on a
    // stop() scheduled against a source that has never been started.
    source.start(startAt);
    if (take.fadeAfterMs !== undefined) {
      const fadeStart = startAt + take.fadeAfterMs / 1000;
      const fadeEnd = fadeStart + (take.fadeOverMs ?? 300) / 1000;
      trim.gain.setValueAtTime(level, fadeStart);
      trim.gain.linearRampToValueAtTime(0, fadeEnd);
      source.stop(fadeEnd);
    }
  }
}

export function setVolume(next: number): void {
  volume = Math.min(1, Math.max(0, next));
  localStorage.setItem(LS_VOL, String(volume));
  if (master && !muted) master.gain.value = volume;
}

export function setMuted(next: boolean): void {
  muted = next;
  localStorage.setItem(LS_MUTE, next ? '1' : '0');
  if (master) master.gain.value = next ? 0 : volume;
}

export const sfxState = {
  get volume() {
    return volume;
  },
  get muted() {
    return muted;
  },
};
