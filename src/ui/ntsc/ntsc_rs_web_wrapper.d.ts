/* Hand-written types for the vendored wasm-bindgen glue.
 * wasm-bindgen emits a .d.ts alongside the .js, but only the .js is recoverable
 * from the deployed sourcemap — so this mirrors the JSDoc in that file.
 * Keep in sync if ntsc_rs_web_wrapper.js is ever re-vendored. */

export const ResizeFilter: {
  readonly Nearest: 0;
  readonly Bilinear: 1;
  readonly Bicubic: 2;
};

export const Rotation: {
  readonly None: 0;
  readonly Cw90: 1;
  readonly Cw180: 2;
  readonly Cw270: 3;
};

/** A handle to the effect's destination buffer. `ptr`/`len` address wasm
 *  memory directly; the buffer itself is owned and reused by NtscEffectBuf,
 *  so `free()` releases only this handle, not the pixels. */
export class EffectOutput {
  free(): void;
  readonly ptr: number;
  readonly len: number;
  readonly width: number;
  readonly height: number;
}

/** Parsed effect settings. Consumed by setEffectSettings — single use. */
export class NtscConfigurator {
  free(): void;
  constructor();
}

export class NtscSettingsList {
  free(): void;
  constructor();
  /** ntsc-rs' own default preset, as JSON. */
  defaultPreset(): string;
  getSettingsList(): string;
  /** Validate + normalise a preset. Throws on ntscQT presets. */
  parsePreset(json: string): string;
  settingsFromJSON(json: string): NtscConfigurator;
}

export class NtscEffectBuf {
  free(): void;
  constructor();
  /** Fresh view into wasm memory each call — never cache it across frames. */
  inputBuffer(width: number, height: number): Uint8Array;
  setEffectSettings(settings: NtscConfigurator): void;
  applyEffect(
    frame_num: number,
    resize_width: number,
    resize_height: number,
    resize_filter: number,
    pad_to_even: boolean,
    effect_enabled: boolean,
    rotation: number,
    rect_top: number,
    rect_right: number,
    rect_bottom: number,
    rect_left: number,
  ): EffectOutput;
}

export function setPanicHook(callback: (msg: string) => void): void;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
}

type ModuleSource =
  | { module_or_path: string | URL | Response | BufferSource | WebAssembly.Module }
  | string
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export function initSync(module: ModuleSource): InitOutput;
export default function init(module_or_path?: ModuleSource): Promise<InitOutput>;
