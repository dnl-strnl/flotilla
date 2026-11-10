import { useState } from 'react';
import { sfxState, setMuted, setVolume } from './player';

// Mute + level, fixed to the corner on every screen. Reads/writes only audio.
export function SfxControl() {
  const [muted, setMutedUI] = useState(sfxState.muted);
  const [volume, setVolumeUI] = useState(sfxState.volume);

  return (
    <div className="sfx-control">
      <button
        className="sfx-mute"
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        onClick={() => {
          const next = !muted;
          setMuted(next);
          setMutedUI(next);
        }}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(volume * 100)}
        aria-label="Sound volume"
        onChange={(e) => {
          const next = Number(e.target.value) / 100;
          setVolume(next);
          setVolumeUI(next);
        }}
      />
    </div>
  );
}
