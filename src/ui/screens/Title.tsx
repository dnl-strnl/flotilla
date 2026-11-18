import { useEffect, useRef } from 'react';
import { playBeats } from '../sfx/player';
import { NtscFilter } from '../ntsc';
import ntscPreset from '../ntsc/preset.json?raw';

const TAU = Math.PI * 2;
const SWEEP_S = 5;
// The card is painted on a small backbuffer (short side this many pixels) so the
// composite filter has roughly the 480p picture it is modelled against.
const BUFFER_SHORT = 540;
const BUFFER_LONG_MAX = 1100;

const BG = '#0a0e12';
const FRIEND = '#39d4c4';
const HAIRLINE = 'rgba(148, 170, 190, 0.14)';
const HAIRLINE_STRONG = 'rgba(148, 170, 190, 0.28)';

// Radar contacts: bearing in degrees clockwise from north, range as a fraction of the
// scope radius. Each one flares as the sweep arm crosses its bearing, then fades.
interface Contact { bearing: number; range: number; foe?: boolean }
const FRIENDLIES: Contact[] = [
  { bearing: 35, range: 0.63 },
  { bearing: 114, range: 0.64 },
  { bearing: 189, range: 0.77 },
];

// One or two hostiles, somewhere new on every page load. Each keeps clear of the wordmark
// band, of the friendlies, and of the other hostile's bloom. Distances are in scope radii.
function scatterHostiles(): Contact[] {
  const at = (c: Contact) => {
    const rad = (c.bearing * Math.PI) / 180;
    return { x: c.range * Math.sin(rad), y: -c.range * Math.cos(rad) };
  };
  const gap = (a: Contact, b: Contact) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
  const hostiles: Contact[] = [];
  const want = Math.random() < 0.5 ? 1 : 2;
  for (let tries = 0; hostiles.length < want && tries < 200; tries++) {
    const c: Contact = { bearing: Math.random() * 360, range: 0.35 + Math.random() * 0.45, foe: true };
    if (Math.abs(at(c).y) < 0.32) continue;
    if (FRIENDLIES.some((f) => gap(c, f) < 0.3)) continue;
    if (hostiles.some((h) => gap(c, h) < 0.55)) continue;
    hostiles.push(c);
  }
  return hostiles;
}

const CONTACTS: Contact[] = [...FRIENDLIES, ...scatterHostiles()];

// Everything behind the lettering: scope, sweep, contacts and the wordmark's dark band.
function paint(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
  const u = Math.min(w, h) / 900; // layout was drawn against a 900px-tall window
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.47;

  ctx.shadowBlur = 0;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // Tube, range rings, crosshair.
  const tube = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  tube.addColorStop(0, '#0f1c22');
  tube.addColorStop(0.75, BG);
  tube.addColorStop(1, '#04070a');
  ctx.fillStyle = tube;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = HAIRLINE_STRONG;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r * i) / 4, 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = HAIRLINE;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Sweep arm: a conic wedge whose bright edge leads, clockwise from north.
  const armDeg = ((t / SWEEP_S) * 360) % 360;
  const sweep = ctx.createConicGradient((armDeg * Math.PI) / 180 - Math.PI / 2, cx, cy);
  sweep.addColorStop(0, 'rgba(57, 212, 196, 0)');
  sweep.addColorStop(0.79, 'rgba(57, 212, 196, 0)');
  sweep.addColorStop(0.83, 'rgba(57, 212, 196, 0.05)');
  sweep.addColorStop(1, 'rgba(57, 212, 196, 0.55)');
  ctx.fillStyle = sweep;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();

  for (const c of CONTACTS) {
    const since = ((armDeg - c.bearing + 360) % 360) / 360; // 0 = just swept
    const rad = (c.bearing * Math.PI) / 180;
    const x = cx + r * c.range * Math.sin(rad);
    const y = cy - r * c.range * Math.cos(rad);
    if (c.foe) {
      // Hostiles blossom: a hot core flares the instant the arm crosses, swells into a
      // wide red bloom, and has only just died away when the arm comes round again.
      const heat = Math.min(1, since / 0.03) * Math.max(0, 1 - since / 0.96) ** 1.5;
      const reach = (10 + 80 * heat ** 0.6) * u;
      const bloom = ctx.createRadialGradient(x, y, 0, x, y, reach);
      bloom.addColorStop(0, `rgba(255, 244, 214, ${heat})`);
      bloom.addColorStop(0.12, `rgba(255, 170, 70, ${0.95 * heat})`);
      bloom.addColorStop(0.4, `rgba(255, 64, 40, ${0.6 * heat})`);
      bloom.addColorStop(1, 'rgba(255, 40, 30, 0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(x, y, reach, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      continue;
    }
    ctx.globalAlpha = 1 - 0.88 * Math.min(1, since / 0.7);
    ctx.fillStyle = ctx.shadowColor = FRIEND;
    ctx.shadowBlur = 12 * u;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, 4 * u), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  ctx.strokeStyle = FRIEND;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();

  // Wordmark band: a dark strip across the scope, fading out toward the screen edges.
  const bandH = 150 * u;
  const band = ctx.createLinearGradient(0, 0, w, 0);
  band.addColorStop(0, 'rgba(10, 14, 18, 0)');
  band.addColorStop(0.22, 'rgba(10, 14, 18, 0.92)');
  band.addColorStop(0.78, 'rgba(10, 14, 18, 0.92)');
  band.addColorStop(1, 'rgba(10, 14, 18, 0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, cy - bandH / 2, w, bandH);
  ctx.fillStyle = HAIRLINE_STRONG;
  ctx.fillRect(0, Math.round(cy - bandH / 2), w, 1);
  ctx.fillRect(0, Math.round(cy + bandH / 2), w, 1);
}

// Title card shown once per page load, in front of the menu. The radar scope is painted on
// a canvas and run through the composite-video filter; the lettering is laid over it
// afterwards, so it stays sharp. Any key or click dismisses it.
export function Title(props: { onStart: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Dev only: N opens the filter's tuning panel, and the card stays put while it is open.
  const tuner = useRef<{ visible: boolean; toggle(): void; destroy(): void } | null>(null);

  const start = () => {
    if (tuner.current?.visible) return;
    playBeats([{ cue: 'ping.send', at: 0 }]);
    props.onStart();
  };

  useEffect(() => {
    const display = canvas.current;
    const dctx = display?.getContext('2d');
    const back = document.createElement('canvas');
    const bctx = back.getContext('2d', { willReadFrequently: true });
    if (!display || !dctx || !bctx) return;

    let live = true;
    let filter: NtscFilter | null = null;
    // Starts clean; the filter cuts in a beat later, once the wasm is up.
    NtscFilter.create(ntscPreset)
      .then(async (f) => {
        if (!live) return;
        filter = f;
        // import.meta.env.DEV folds to false in a build, so the tuner never reaches dist.
        if (import.meta.env.DEV) {
          const { NtscTuner } = await import('../ntsc/tuner');
          if (live) tuner.current = new NtscTuner(f, JSON.parse(ntscPreset));
        }
      })
      .catch((err) => console.error('[ntsc] failed to load, title runs clean:', err));

    let raf = 0;
    const frame = (ms: number) => {
      const aspect = window.innerWidth / Math.max(1, window.innerHeight);
      const long = Math.min(BUFFER_LONG_MAX, Math.round(BUFFER_SHORT * Math.max(aspect, 1 / aspect)));
      const w = aspect >= 1 ? long : BUFFER_SHORT;
      const h = aspect >= 1 ? BUFFER_SHORT : long;
      if (back.width !== w || back.height !== h) {
        back.width = w;
        back.height = h;
      }
      paint(bctx, w, h, ms / 1000);

      if (filter?.enabled) {
        const out = filter.apply(bctx.getImageData(0, 0, w, h));
        if (display.width !== out.width || display.height !== out.height) {
          display.width = out.width;
          display.height = out.height;
        }
        dctx.putImageData(out, 0, 0);
      } else {
        if (display.width !== w || display.height !== h) {
          display.width = w;
          display.height = h;
        }
        dctx.drawImage(back, 0, 0);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      live = false;
      cancelAnimationFrame(raf);
      tuner.current?.destroy();
      tuner.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Shift' || e.key === 'Tab') return;
      if (import.meta.env.DEV && e.code === 'KeyN' && tuner.current) {
        if (!e.repeat && !(e.target instanceof HTMLInputElement)) tuner.current.toggle();
        return;
      }
      start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="title-screen" onClick={start}>
      <canvas ref={canvas} className="title-canvas" />
      <div className="title-corner title-corner--left">
        BRG 284°<br />RNG 10 × 10<br />CONTACTS {String(CONTACTS.length).padStart(2, '0')}
      </div>
      <div className="title-corner title-corner--right">
        EST. 2026<br />AP 5 / 5<br />v{__APP_VERSION__}
      </div>
      <div className="title-band">
        <h1 className="title-wordmark">FLOTILLA</h1>
        <div className="title-sub">NAVAL ACTION-ECONOMY WARGAME</div>
      </div>
      <div className="title-prompt">▸ PRESS ANY KEY</div>
    </div>
  );
}
