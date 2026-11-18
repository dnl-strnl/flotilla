import init, {
  NtscEffectBuf,
  NtscSettingsList,
  ResizeFilter,
  Rotation,
} from './ntsc_rs_web_wrapper.js';
import wasmUrl from './ntsc_rs_web_wrapper_bg.wasm?url';

let ready: ReturnType<typeof init> | null = null;

/** The real ntsc-rs composite-signal simulation, run over the finished frame.
 *  Lifted from home-game (src/engine/ntsc); used only by the title screen.
 *
 *  The wasm is vendored from web.ntsc.rs (see LICENSES.md). Its API is already
 *  shaped like a game filter: buffers are reused across calls, and the frame
 *  number drives the temporal artifacts (head-switching tear, tracking noise),
 *  so they animate instead of sitting still.
 *
 *  Construction is async; `apply` is synchronous, so render() stays sync. */
export class NtscFilter {
  /** Working scale. The effect is modelled against ~480p, which is about what the
   *  title screen renders at, so 1 is true to the preset. 2 nearest-upscales first:
   *  finer artifacts, 4x the pixels. */
  scale: 1 | 2 = 1;
  enabled = true;
  /** Wall time of the last apply(), for the tuner's readout. */
  lastMs = 0;

  private frame = 0;

  private constructor(
    private readonly buf: NtscEffectBuf,
    private readonly list: NtscSettingsList,
    private readonly mem: WebAssembly.Memory,
  ) {}

  static async create(presetJson: string) {
    // One instantiation, shared: React StrictMode mounts the title twice in dev, and two
    // overlapping init() calls leave the glue pointing at the wrong module's memory.
    const { memory } = await (ready ??= init({ module_or_path: wasmUrl }));
    const f = new NtscFilter(new NtscEffectBuf(), new NtscSettingsList(), memory);
    f.setPreset(presetJson);
    return f;
  }

  /** Swap in a preset exported from web.ntsc.rs ("Save to file" / "Copy to
   *  clipboard"). Throws if the JSON isn't an ntsc-rs preset. */
  setPreset(json: string) {
    // settingsFromJSON hands over a configurator that setEffectSettings
    // consumes, so this has to be a fresh one every time.
    this.buf.setEffectSettings(this.list.settingsFromJSON(json));
  }

  /** Every knob the effect has, as self-describing descriptors — label, range,
   *  enum options, nesting. This is the same data web.ntsc.rs builds its own
   *  sliders from, which is why the tuner can generate its UI instead of
   *  hard-coding 49 controls. */
  schema(): NtscDescriptor[] {
    return JSON.parse(this.list.getSettingsList());
  }

  /** ntsc-rs' own defaults, as preset JSON. */
  defaultPreset(): string {
    return this.list.defaultPreset();
  }

  /** The returned ImageData is a view straight into wasm memory — valid only
   *  until the next apply(). Draw it, don't keep it. */
  apply(src: ImageData): ImageData {
    this.buf.inputBuffer(src.width, src.height).set(src.data);

    const rw = src.width * this.scale;
    const rh = src.height * this.scale;
    const t0 = performance.now();
    const out = this.buf.applyEffect(
      this.frame++,
      rw,
      rh,
      ResizeFilter.Nearest,
      true, // pad to even: the source size follows the window and can land odd
      this.enabled,
      Rotation.None,
      0,
      rw,
      rh,
      0,
    );

    this.lastMs = performance.now() - t0;

    // Read .buffer AFTER the call — wasm memory may have grown, which detaches
    // any view taken before it.
    const px = new Uint8ClampedArray(this.mem.buffer, out.ptr, out.len);
    const img = new ImageData(px, out.width, out.height);
    out.free(); // the handle only; the pixels belong to NtscEffectBuf
    return img;
  }
}

/** Setting kinds, as reported by `schema()`. */
export const Kind = {
  Enumeration: 0,
  Percentage: 1,
  IntRange: 2,
  FloatRange: 3,
  Boolean: 4,
  Group: 5,
} as const;

export interface NtscDescriptor {
  label: string;
  description: string | null;
  id: number;
  /** Matches the key used in preset JSON. */
  idName: string;
  kind: (typeof Kind)[keyof typeof Kind];
  value: {
    min?: number;
    max?: number;
    logarithmic?: boolean;
    defaultValue: number | boolean;
    options?: { label: string; description: string | null; index: number }[];
    /** Groups are themselves a boolean, with children nested under them. */
    children?: NtscDescriptor[];
  };
}

/** A preset is a flat map of idName -> value, plus a format version. */
export type NtscPreset = Record<string, number | boolean>;
