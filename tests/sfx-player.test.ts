import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression: playBeats must start() a buffer source before its stop() — real Web Audio
// throws InvalidStateError otherwise (hit cues with fadeAfterMs, e.g. move.ship). The
// fakes below enforce the same ordering rule.

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}

class FakeNode {
  gain = new FakeParam();
  connect<T>(next: T): T {
    return next;
  }
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  private started = false;
  start() {
    this.started = true;
  }
  stop() {
    if (!this.started) throw new DOMException('cannot stop an unstarted source', 'InvalidStateError');
  }
}

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = new FakeNode();
  createGain() {
    return new FakeNode();
  }
  createBufferSource() {
    return new FakeSource();
  }
  async decodeAudioData() {
    return {} as AudioBuffer;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sfx player scheduling', () => {
  it('starts a faded source before scheduling its stop', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('manifest.json')
          ? { ok: true, json: async () => ({ 'move.ship': [{ src: 'move.mp3', fadeAfterMs: 100 }] }) }
          : { ok: true, arrayBuffer: async () => new ArrayBuffer(0) },
      ),
    );
    const { initSfx, playBeats } = await import('../src/ui/sfx/player');
    await initSfx();
    expect(() => playBeats([{ cue: 'move.ship', at: 0 }])).not.toThrow();
  });
});
