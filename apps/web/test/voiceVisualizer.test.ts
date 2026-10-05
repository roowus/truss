import { test } from "node:test";
import assert from "node:assert/strict";
import type { MediaStreamLike } from "../src/lib/voice.js";

/* SPEC-TESTS for the dictation audio visualizer —
   https://github.com/roowus/truss/issues/112
   ("Have an audio visualizer for when using voice to talk"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Today: the recording state shows a static amber chip ("Dictating…") and
   nothing else — the user talks into the void with zero feedback that the
   mic hears them (ChatPanel.tsx:634-636). The capture seam already exists
   and is test-friendly: mediaRecorderCapture takes injected
   getUserMedia/createRecorder (voice.ts) — the visualizer rides the same
   pattern.

   The contract, two pure seams:

   1. src/lib/voiceLevel.ts —

        levelBars(frame: ArrayLike<number>, barCount: number, prev?: number[]): number[]

      Maps one analyser frame (frequency bins, 0..255) to barCount heights in
      [0,1]. Rules: output length === barCount; values in [0,1]; silence →
      ~0; loud → ~1; `prev` smooths (a spike decays gradually, never
      instantly to zero); empty frames never NaN.

   2. voice.ts mediaRecorderCapture: the returned recorder exposes the live
      mic stream for visualization —

        recorder.levelStream(): MediaStreamLike | null

      null before start and after stop/cancel; the granted stream while the
      take runs. (The generation-guard from the B2/B5 audit findings must
      still hold: a stale take never exposes a stream.) */

interface VoiceLevelModule {
  levelBars(frame: ArrayLike<number>, barCount: number, prev?: number[]): number[];
}

async function loadLevel(): Promise<VoiceLevelModule | null> {
  const spec = "../src/lib/voiceLevel"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const silent = new Uint8Array(64).fill(128); // time-domain center = silence
const loud = new Uint8Array(64).fill(255); // max amplitude

test("src/lib/voiceLevel.ts exists", async () => {
  const mod = await loadLevel();
  assert.ok(mod, "src/lib/voiceLevel.ts must export levelBars — see issue #112");
});

test("levelBars: shape, range, silence vs loud", async () => {
  const mod = await loadLevel();
  assert.ok(mod, "voiceLevel module must exist (see module test)");

  const bars = mod.levelBars(loud, 8);
  assert.equal(bars.length, 8, "exactly barCount bars");
  for (const b of bars) assert.ok(b >= 0 && b <= 1 && Number.isFinite(b), `every bar in [0,1] (got ${b})`);

  const quiet = mod.levelBars(silent, 8);
  assert.ok(Math.max(...quiet) < 0.1, "silence reads ~0 — a dead-quiet room doesn't light up");
  assert.ok(Math.min(...bars) > 0.8, "a loud frame reads ~1");

  assert.deepEqual(mod.levelBars(new Uint8Array(0), 8).map(() => 0), new Array(8).fill(0), "empty frames are zeroed, never NaN");
  assert.ok(mod.levelBars(new Uint8Array(0), 8).every(Number.isFinite), "no NaN on empty input");
});

test("levelBars: smoothing — a spike decays gradually, silence stays calm", async () => {
  const mod = await loadLevel();
  assert.ok(mod, "voiceLevel module must exist (see module test)");

  const hot = mod.levelBars(loud, 6);
  const decaying = mod.levelBars(silent, 6, hot);
  for (let i = 0; i < 6; i++) {
    assert.ok(decaying[i] < hot[i], "after silence, bars fall…");
    assert.ok(decaying[i] > 0.05, "…but never snap to zero (the visual pops otherwise)");
    assert.ok(decaying[i] >= hot[i] * 0.25, "decay is a glide, not a cliff");
  }
  /* and noise can't flicker silence */
  const calm = mod.levelBars(silent, 6, mod.levelBars(silent, 6));
  assert.ok(Math.max(...calm) < 0.1, "silence in, calm out");
});

test("the capture exposes the live stream for visualization — with the generation guard intact", async () => {
  const { mediaRecorderCapture } = await import("../src/lib/voice.js");
  const stream = { getTracks: () => [{ stop() {} }] };
  const rec = mediaRecorderCapture({
    getUserMedia: async () => stream as never,
    createRecorder: () => {
      const fake = { mimeType: "audio/webm", ondataavailable: null, onstop: null as null | (() => void), start() {}, stop() { fake.onstop?.(); } };
      return fake as never;
    },
  });

  const ls = (rec as any).levelStream;
  assert.equal(typeof ls, "function", "the recorder must expose levelStream() so a visualizer can attach an analyser — see issue #112");

  assert.equal(ls.call(rec), null, "nothing before start");
  await rec.start();
  assert.equal(ls.call(rec), stream, "the granted stream, while the take runs");
  await rec.stop();
  assert.equal(ls.call(rec), null, "released with the take — no zombie mic attachment");

  /* the B2/B5 guard still holds: a take cancelled mid-permission-prompt
     never leaks a stream to a visualizer either */
  let resolveMic: ((s: MediaStreamLike) => void) | undefined;
  const slow = mediaRecorderCapture({
    getUserMedia: () => new Promise<MediaStreamLike>((r) => { resolveMic = r; }),
    createRecorder: () => ({ mimeType: "audio/webm", ondataavailable: null, onstop: null, start() {}, stop() {} }) as never,
  });
  const starting = slow.start();
  slow.cancel?.(); // cancel is optional in the VoiceRecorder interface
  if (!resolveMic) throw new Error("the prompt should be pending");
  const grant = resolveMic;
  grant({ getTracks: () => [{ stop() {} }] });
  await starting;
  assert.equal((slow as any).levelStream?.() ?? null, null, "a stale take exposes nothing");
});
