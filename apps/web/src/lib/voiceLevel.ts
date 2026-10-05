/* Frame→bars mapping for the dictation visualizer (issue #112). Pure and
   DOM-free so the mapping is node-testable; the component feeds it analyser
   bytes on a rAF loop (time domain, 128 = silence, 0/255 = full swing).

   Contract (pinned by apps/web/test/voiceVisualizer.test.ts): exactly
   barCount heights in [0,1]; silence reads ~0, a loud frame ~1; an empty
   frame is zeroed and never NaN; `prev` smooths — attack is instant, the
   release glides (a spike decays gradually, never snaps to zero). */

/** per-frame release factor when the raw level falls below the last height */
const RELEASE = 0.55;

export function levelBars(frame: ArrayLike<number>, barCount: number, prev?: number[]): number[] {
  const count = Math.max(0, Math.floor(barCount));
  const out = new Array<number>(count);
  const n = frame.length;
  for (let i = 0; i < count; i++) {
    let raw = 0;
    if (n > 0) {
      /* this bar's bucket of the frame: peak deviation from the 128 center,
         normalized to [0,1] */
      const from = Math.floor((i * n) / count);
      const to = Math.min(n, Math.max(from + 1, Math.floor(((i + 1) * n) / count)));
      for (let j = from; j < to; j++) {
        const v = Number(frame[j]);
        const d = Math.abs((Number.isFinite(v) ? v : 128) - 128) / 128;
        if (d > raw) raw = d;
      }
    }
    const p = prev && i < prev.length && Number.isFinite(prev[i]) ? prev[i] : 0;
    const v = raw >= p ? raw : p * RELEASE; // fast attack, gliding release
    out[i] = Math.min(1, Math.max(0, v));
  }
  return out;
}
