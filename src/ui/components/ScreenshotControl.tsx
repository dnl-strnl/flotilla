import { useState } from 'react';
import { toBlob } from 'html-to-image';

// One-click PNG capture of the current screen; both corner overlays are filtered out of
// the image. Pure edge effect, no reducer involvement.
export function ScreenshotControl() {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const capture = async () => {
    const root = document.getElementById('root');
    if (!root || busy) return;
    setBusy(true);
    try {
      const blob = await toBlob(root, {
        pixelRatio: 2,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        filter: (node) =>
          !(
            node.classList?.contains('sfx-control') ||
            node.classList?.contains('screenshot-control')
          ),
      });
      if (!blob) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flotilla-${stamp}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="screenshot-control"
      aria-label="Save screenshot"
      title="Save screenshot"
      disabled={busy}
      onClick={capture}
    >
      {saved ? '✓' : '💾'}
    </button>
  );
}
