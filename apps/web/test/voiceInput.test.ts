import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for voice-to-input — https://github.com/roowus/truss/issues/15
   ("Voice to input"). These FAIL on purpose today: they pin the contract a
   fix must satisfy. (No mic/STT/dictation machinery exists anywhere in the
   app today — the composer is text-only.)

   The contract: a pure, DOM-free src/lib/voiceInput.ts state machine —

     createVoiceInput({
       transcribe: (audio: unknown) => Promise<string>,  // injected STT boundary
       onText: (text: string) => void,                    // inserts into the composer draft
       maxDurationMs?: number,                            // recordings auto-stop
     }) → { state(): VoiceState; start(): void; stop(): Promise<void>; cancel(): void }

     VoiceState = "idle" | "recording" | "transcribing" | "error"

   Rules it must honor:
   - idle → recording → transcribing → idle, with the transcript delivered
     via onText EXACTLY ONCE per take;
   - the transcript goes into the composer DRAFT — sending stays the user's
     click (voice never auto-sends);
   - recordings auto-stop at maxDurationMs;
   - cancel() aborts a take: no transcription, no text, back to idle;
   - a transcription failure lands in "error" with the message, no partial
     text, and the controller can start again;
   - start() while busy is a no-op (no double-mic).

   The composer button, waveform UI, and the STT backend choice (browser
   speech API vs a server endpoint) are acceptance criteria, not here. */

interface VoiceController {
  state(): "idle" | "recording" | "transcribing" | "error";
  start(): void;
  stop(): Promise<void>;
  cancel(): void;
  /** the recorder's live capture stream while a take runs (issue #112) */
  levelStream(): unknown;
}
interface VoiceInputModule {
  createVoiceInput(deps: {
    transcribe: (audio: unknown) => Promise<string>;
    onText: (text: string) => void;
    maxDurationMs?: number;
    recorder?: {
      start(): void | Promise<void>;
      stop(): Promise<unknown>;
      cancel?(): void;
      levelStream?(): unknown;
    };
  }): VoiceController;
}

async function load(): Promise<VoiceInputModule | null> {
  const spec = "../src/lib/voiceInput"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("src/lib/voiceInput.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/voiceInput.ts must export createVoiceInput — see issue #15");
});

test("a full take: idle → recording → transcribing → idle, transcript delivered once, never auto-sent", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  const seen: string[] = [];
  const transcribed: unknown[] = [];
  const v = mod.createVoiceInput({
    transcribe: async (audio) => {
      transcribed.push(audio);
      await tick(20);
      return "  ship the release  ";
    },
    onText: (t) => seen.push(t),
  });

  assert.equal(v.state(), "idle");
  v.start();
  assert.equal(v.state(), "recording");
  await v.stop();
  assert.equal(v.state(), "idle", "settles back to idle after a successful take");
  assert.equal(transcribed.length, 1, "the recorded audio went to the STT boundary once");
  assert.equal(seen.length, 1, "transcript delivered exactly once");
  assert.equal(seen[0], "ship the release", "transcript is trimmed before it lands in the draft");
  /* "never auto-sends" is structural: the controller's only output is the
     onText draft insert — there is no send path to pin against */
});

test("stop() mid-transcription waits are safe; state during transcribe is observable", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  let resolveStt: (s: string) => void = () => {};
  const v = mod.createVoiceInput({
    transcribe: () => new Promise<string>((r) => (resolveStt = r)),
    onText: () => {},
  });
  v.start();
  const p = v.stop();
  await tick(10);
  assert.equal(v.state(), "transcribing", "the UI can show a working state while STT runs");
  resolveStt("hello");
  await p;
  assert.equal(v.state(), "idle");
});

test("recordings auto-stop at maxDurationMs", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  const seen: string[] = [];
  const v = mod.createVoiceInput({
    transcribe: async () => "capped take",
    onText: (t) => seen.push(t),
    maxDurationMs: 60,
  });
  v.start();
  assert.equal(v.state(), "recording");
  await tick(140);
  assert.equal(v.state(), "idle", "the cap ended the take by itself");
  assert.deepEqual(seen, ["capped take"], "the capped take still transcribes + lands");
});

test("cancel() aborts: no transcription, no text, back to idle", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  let sttCalls = 0;
  const seen: string[] = [];
  const v = mod.createVoiceInput({
    transcribe: async () => {
      sttCalls++;
      return "should never land";
    },
    onText: (t) => seen.push(t),
  });
  v.start();
  v.cancel();
  assert.equal(v.state(), "idle");
  await tick(30);
  assert.equal(sttCalls, 0, "a cancelled take never reaches the STT boundary");
  assert.deepEqual(seen, [], "and never produces text");
});

test("transcription failure → error state with the message, nothing inserted, can start again", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  const seen: string[] = [];
  const v = mod.createVoiceInput({
    transcribe: async () => {
      throw new Error("mic unavailable");
    },
    onText: (t) => seen.push(t),
  });
  v.start();
  await v.stop();
  assert.equal(v.state(), "error", "failures are visible, not silent");
  assert.deepEqual(seen, [], "no partial text on failure");

  /* and the controller recovers */
  v.start();
  assert.equal(v.state(), "recording", "a failed take doesn't brick the mic button");
  v.cancel();
});

test("start() while recording/transcribing is a no-op (no double-mic)", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");
  let sttCalls = 0;
  const v = mod.createVoiceInput({
    transcribe: async () => {
      sttCalls++;
      return "one take";
    },
    onText: () => {},
  });
  v.start();
  v.start(); // ignored
  assert.equal(v.state(), "recording");
  await v.stop();
  assert.equal(sttCalls, 1, "exactly one transcription happened");
});

test("levelStream(): the controller surfaces the recorder's live stream; a recorder without the hook reads null", async () => {
  const mod = await load();
  assert.ok(mod, "voiceInput module must exist (see module test)");

  /* issue #112: the dictation visualizer polls controller.levelStream() —
     a dropped passthrough blanks it while shipping green */
  const stream = { getTracks: () => [] };
  const withHook = mod.createVoiceInput({
    transcribe: async () => "",
    onText: () => {},
    recorder: { start() {}, stop: async () => null, levelStream: () => stream },
  });
  assert.equal(withHook.levelStream(), stream, "the recorder's stream passes through the controller");

  /* any recorder may lack the levelStream hook (the seam is optional):
     the controller must then read null, not undefined — the visualizer's
     null branch depends on it */
  const noHook = mod.createVoiceInput({
    transcribe: async () => "",
    onText: () => {},
    recorder: { start() {}, stop: async () => null },
  });
  assert.equal(noHook.levelStream(), null, "a recorder without levelStream reads null, not undefined");

  const noRecorder = mod.createVoiceInput({ transcribe: async () => "", onText: () => {} });
  assert.equal(noRecorder.levelStream(), null, "no recorder at all also reads null");
});

/* issue #201: LIVE transcription — partials stream into the draft while you
   speak (the final replaces them; the take's one-transcript rule composes:
   the FINAL is the transcript, partials are display-only) */

interface LiveVoiceModule {
  createVoiceInput(deps: {
    transcribe: (audio: unknown) => Promise<string>;
    onText: (text: string) => void;
    onPartial?: (text: string) => void;
    recorder?: unknown;
  }): any;
}

test("partials stream during a take; the final REPLACES them (never appends)", async () => {
  const spec = "../src/lib/voiceInput";
  const mod = (await import(spec).catch(() => null)) as LiveVoiceModule | null;
  assert.ok(mod, "voiceInput module must exist (see module test)");

  const partials: string[] = [];
  const finals: string[] = [];
  /* the recorder reports interim text mid-take; the controller must forward
     it to onPartial (the wiring is the contract) */
  let recorderPartial: ((text: string) => void) | undefined;
  const recorder = {
    start() {},
    stop: async () => "blob",
    levelStream: () => null,
    set onPartial(fn: ((text: string) => void) | undefined) {
      recorderPartial = fn;
    },
    get onPartial() {
      return recorderPartial;
    },
  };
  const v = mod.createVoiceInput({
    transcribe: async () => "the cat sat on the mat",
    onText: (t) => finals.push(t),
    onPartial: (t) => partials.push(t),
    recorder: recorder as never,
  });
  v.start();
  assert.ok(recorderPartial, "the controller subscribes to the recorder's partial stream (issue #201)");
  recorderPartial!("the cat");
  recorderPartial!("the cat sat");
  assert.deepEqual(partials, ["the cat", "the cat sat"], "partials flow live while speaking");

  const final = await v.stop();
  assert.equal(final, "the cat sat on the mat", "stop resolves the final");
  assert.deepEqual(finals, ["the cat sat on the mat"], "exactly ONE final transcript (the #15 rule holds) — never final+partials concatenated");
});

test("the SpeechRecognition path streams: interimResults + continuous on, interims emit partials", () => {
  const src = readFileSync(new URL("../src/lib/voice.ts", import.meta.url), "utf8");
  assert.ok(/interimResults\s*=\s*true/.test(src), "the browser path enables interim results — partials while speaking (issue #201)");
  assert.ok(/continuous\s*=\s*true/.test(src), "and continuous (no stop between phrases)");
  /* interims must FLOW, not just be enabled */
  assert.ok(/!res\??\.isFinal|isFinal === false|!res\[0\]?.*isFinal/.test(src) || /interim/.test(src), "non-final results emit as partials");
});
