import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTranscript, createBrowserVoiceInput, mediaRecorderCapture, recognitionRecorder, transcribeAudio, type MediaRecorderLike, type MediaStreamLike } from "../src/lib/voice";
import { createVoiceInput } from "../src/lib/voiceInput";

/* Companion tests for the DOM-side voice wiring (issue #15) — the pure
   parts: draft appending, the server-route STT boundary, and the recorder
   seam. The state machine's issue contract is pinned by voiceInput.test.ts;
   the audit-regression pins for it live here so that file stays verbatim. */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("appendTranscript joins a take onto the draft with one space", () => {
  assert.equal(appendTranscript("", "hello"), "hello");
  assert.equal(appendTranscript("  ", "hello"), "hello", "a whitespace draft is an empty draft");
  assert.equal(appendTranscript("ship it", "tomorrow"), "ship it tomorrow");
  assert.equal(appendTranscript("ship it  \n", "tomorrow"), "ship it tomorrow", "trailing whitespace collapses");
  assert.equal(appendTranscript("draft", "  padded  "), "draft padded");
});

test("appendTranscript with an empty take leaves the draft untouched", () => {
  assert.equal(appendTranscript("keep me", "   "), "keep me");
  assert.equal(appendTranscript("", ""), "");
});

test("transcribeAudio passes browser-recognized strings through", async () => {
  assert.equal(await transcribeAudio("already text"), "already text");
});

test("transcribeAudio posts blobs to /api/transcribe and returns its text", async () => {
  const orig = globalThis.fetch;
  let seenBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ text: "from the server" }), { status: 200 });
  }) as typeof fetch;
  try {
    const text = await transcribeAudio(new Blob(["audio-bytes"], { type: "audio/webm" }));
    assert.equal(text, "from the server");
    assert.equal(seenBody.mime, "audio/webm");
    assert.equal(typeof seenBody.audioBase64, "string");
    assert.equal(Buffer.from(seenBody.audioBase64, "base64").toString(), "audio-bytes");
  } finally {
    globalThis.fetch = orig;
  }
});

test("transcribeAudio surfaces the server's error message", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "voice transcription is not configured on this server (set TRUSS_TRANSCRIBE_URL)" }), { status: 501 })) as typeof fetch;
  try {
    await assert.rejects(transcribeAudio(new Blob(["x"])), /TRUSS_TRANSCRIBE_URL/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("transcribeAudio on an empty take is a no-op, not a request", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}");
  }) as typeof fetch;
  try {
    assert.equal(await transcribeAudio(new Blob([])), "");
    assert.equal(calls, 0, "no server round trip for silence");
  } finally {
    globalThis.fetch = orig;
  }
});

/* ── audit round 1, B1: stop() re-entry during the settle window ── */

test("B1: a second stop() mid-settle does not duplicate the transcript", async () => {
  const seen: string[] = [];
  let sttCalls = 0;
  const v = createVoiceInput({
    recorder: { start() {}, stop: () => tick(30).then(() => "audio") },
    transcribe: async () => {
      sttCalls++;
      return "one take";
    },
    onText: (t) => seen.push(t),
  });
  v.start();
  const p1 = v.stop();
  const p2 = v.stop(); // a double-click inside the settle window
  await Promise.all([p1, p2]);
  assert.equal(sttCalls, 1, "one transcription, not two");
  assert.deepEqual(seen, ["one take"], "the transcript lands once");
});

test("B1: the cap timer firing mid-settle does not duplicate the take either", async () => {
  const seen: string[] = [];
  const v = createVoiceInput({
    recorder: { start() {}, stop: () => tick(60).then(() => "audio") }, // slow recorder: timer lands in the window
    transcribe: async () => "capped",
    onText: (t) => seen.push(t),
    maxDurationMs: 10,
  });
  v.start();
  await tick(150);
  assert.equal(v.state(), "idle");
  assert.deepEqual(seen, ["capped"], "one landing even though the timer raced the settle");
});

test("B1 follow-through: after a cancel mid-transcribe, the next take's stop() runs its own take", async () => {
  const seen: string[] = [];
  const resolvers: ((s: string) => void)[] = [];
  const v = createVoiceInput({
    transcribe: () => new Promise<string>((r) => resolvers.push(r)),
    onText: (t) => seen.push(t),
  });
  v.start();
  const p1 = v.stop();
  await tick(5);
  assert.equal(v.state(), "transcribing");
  v.cancel();
  v.start();
  const p2 = v.stop(); // must not be handed the stale take's promise
  await tick(5);
  assert.equal(resolvers.length, 2, "the second take reached the STT boundary on its own");
  resolvers[0]?.("stale take");
  await p1;
  await tick(5);
  assert.deepEqual(seen, [], "the cancelled take never lands");
  resolvers[1]?.("fresh take");
  await p2;
  assert.deepEqual(seen, ["fresh take"], "the new take delivers its own transcript");
});

/* ── audit round 1, B2: cancel during the mic-permission prompt ── */

function fakePlatform() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream: MediaStreamLike = { getTracks: () => [track] };
  const recorders: MediaRecorderLike[] = [];
  const createRecorder = (): MediaRecorderLike => {
    const r: MediaRecorderLike = {
      mimeType: "audio/webm",
      ondataavailable: null,
      onstop: null,
      start() {},
      stop() {
        queueMicrotask(() => r.onstop?.());
      },
    };
    recorders.push(r);
    return r;
  };
  return { track, stream, createRecorder, recorders };
}

test("B2: cancelling while the permission prompt is open releases the mic and starts nothing", async () => {
  const pf = fakePlatform();
  let resolveGum: (s: MediaStreamLike) => void = () => {};
  const rec = mediaRecorderCapture({
    getUserMedia: () => new Promise<MediaStreamLike>((r) => (resolveGum = r)),
    createRecorder: pf.createRecorder,
  });
  const started = rec.start();
  rec.cancel?.(); // Esc while the browser prompt is up
  resolveGum(pf.stream); // …and then the user grants permission
  await started;
  assert.equal(pf.track.stopped, true, "the just-granted mic is released immediately");
  assert.equal(pf.recorders.length, 0, "no orphaned recording starts");
  assert.equal(((await rec.stop()) as Blob).size, 0, "and there is nothing to transcribe");
});

test("mediaRecorderCapture records chunks and stops with the blob, tracks released", async () => {
  const pf = fakePlatform();
  const rec = mediaRecorderCapture({
    getUserMedia: async () => pf.stream,
    createRecorder: pf.createRecorder,
  });
  await rec.start();
  const r = pf.recorders[0];
  assert.ok(r, "a recorder was created");
  r.ondataavailable?.({ data: new Blob(["chunk-1"]) });
  const blob = (await rec.stop()) as Blob;
  assert.equal(blob.size, 7);
  assert.equal(pf.track.stopped, true, "stopping releases the mic");
});

/* ── audit round 2, B5: stop() during capture startup ── */

test("B5: stop() while capture startup is pending releases the mic and starts nothing", async () => {
  const pf = fakePlatform();
  let resolveGum: (s: MediaStreamLike) => void = () => {};
  const rec = mediaRecorderCapture({
    getUserMedia: () => new Promise<MediaStreamLike>((r) => (resolveGum = r)),
    createRecorder: pf.createRecorder,
  });
  const started = rec.start();
  const empty = (await rec.stop()) as Blob; // mic clicked again before startup finished
  assert.equal(empty.size, 0, "the take ends empty");
  resolveGum(pf.stream); // the prompt/startup resolves afterwards
  await started;
  assert.equal(pf.track.stopped, true, "the late mic grant is released, not recorded");
  assert.equal(pf.recorders.length, 0, "no orphaned recording starts");
});

test("B5 follow-through: overlapping startups cannot clear each other's invalidation", async () => {
  /* take 1 cancelled mid-prompt, take 2 started before take 1's prompt
     resolves: the stale grant must be released, the fresh one must record */
  const resolvers: ((s: MediaStreamLike) => void)[] = [];
  const tracks = [
    { stopped: false, stop() { this.stopped = true; } },
    { stopped: false, stop() { this.stopped = true; } },
  ];
  const streams = tracks.map((t) => ({ getTracks: () => [t] }));
  const pf = fakePlatform();
  const rec = mediaRecorderCapture({
    getUserMedia: () => new Promise<MediaStreamLike>((r) => resolvers.push(r)),
    createRecorder: pf.createRecorder,
  });
  const s1 = rec.start();
  rec.cancel?.(); // take 1 dies at the prompt
  const s2 = rec.start(); // take 2 starts before take 1's grant arrives
  resolvers[0]?.(streams[0]); // stale grant first
  await s1;
  assert.equal(tracks[0].stopped, true, "the stale grant is released");
  assert.equal(pf.recorders.length, 0, "no recorder from the stale startup");
  resolvers[1]?.(streams[1]);
  await s2;
  assert.equal(tracks[1].stopped, false, "the fresh take's mic is live");
  assert.equal(pf.recorders.length, 1, "exactly one recorder, from the fresh take");
  rec.cancel?.();
  assert.equal(tracks[1].stopped, true, "and it releases cleanly");
});

test("createBrowserVoiceInput: the typed levelStream seam exists and reads null before any take", () => {
  /* issue #112, audit round 1 (I1): the browser controller re-wraps
     createVoiceInput's passthrough — a dropped method or a lost ?? null
     blanks the visualizer while shipping green. Node has no window, so
     this builds the MediaRecorder-path controller without touching the
     mic (nothing is requested until start()). */
  const v = createBrowserVoiceInput({ onText: () => {} });
  assert.equal(typeof v.levelStream, "function", "the browser controller exposes levelStream()");
  assert.equal(v.levelStream(), null, "no take running → no stream");
});

/* ── issue #112: the SpeechRecognition path's metering-only stream ──
   The browser recognizer owns its audio and exposes no stream, so the
   visualizer would have nothing to read on Chrome/Edge/Safari. A take
   therefore opens a parallel metering-only getUserMedia whose lifetime
   mirrors the capture path's generation guard. */

function fakeSpeechRecognition() {
  const instances: {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: unknown;
    onerror: ((e: { error?: string }) => void) | null;
    onend: (() => void) | null;
    started: boolean;
    stopped: boolean;
    aborted: boolean;
  }[] = [];
  class Fake {
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: unknown = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    stopped = false;
    aborted = false;
    start() {
      this.started = true;
      instances.push(this);
    }
    stop() {
      this.stopped = true;
      this.onend?.();
    }
    abort() {
      this.aborted = true;
    }
  }
  return { Ctor: Fake as never, instances };
}

const meterStreamOf = () => {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { stream: { getTracks: () => tracks }, tracks };
};

test("recognition recorder: metering stream is null → live → released across a take", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const { stream, tracks } = meterStreamOf();
  const rec = recognitionRecorder(Ctor, { getUserMedia: async () => stream as never });

  assert.equal(rec.levelStream(), null, "nothing before start");
  rec.start();
  await tick(1); // let the metering grant land
  assert.equal(rec.levelStream(), stream, "the metering stream is live while the take runs");
  const done = rec.stop();
  instances[0]!.onend?.();
  await done;
  assert.equal(rec.levelStream(), null, "released with the take");
  assert.equal(tracks[0]!.stopped, true, "metering tracks stopped — no zombie mic");
});

test("recognition recorder: a take cancelled mid-metering-prompt releases the late grant", async () => {
  const { Ctor } = fakeSpeechRecognition();
  const { stream, tracks } = meterStreamOf();
  let grant: ((s: MediaStreamLike) => void) | undefined;
  const rec = recognitionRecorder(Ctor, { getUserMedia: () => new Promise<MediaStreamLike>((r) => { grant = r; }) });
  rec.start();
  rec.cancel?.(); // user bails while the prompt is up
  grant?.(stream as never); // the grant arrives late
  await tick(1);
  assert.equal(rec.levelStream(), null, "a stale take exposes nothing");
  assert.equal(tracks[0]!.stopped, true, "the late grant is released, not leaked");
});

test("recognition recorder: metering failure never breaks the take", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const rec = recognitionRecorder(Ctor, { getUserMedia: () => Promise.reject(new Error("no metering device")) });
  rec.start();
  await tick(1);
  assert.equal(rec.levelStream(), null, "no stream, bars stay hidden — honest");
  const done = rec.stop();
  instances[0]!.onresult = null;
  instances[0]!.onend?.();
  assert.equal(await done, "", "the take itself is unaffected");
});

test("recognition recorder without a metering dep: no stream, take unaffected", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const rec = recognitionRecorder(Ctor);
  assert.equal(rec.levelStream(), null);
  rec.start();
  await tick(1);
  assert.equal(rec.levelStream(), null, "no metering requested, nothing to expose");
  const done = rec.stop();
  instances[0]!.onend?.();
  await done;
});

test("recognition recorder: the metering mic dies with the take — onerror path (audit round 5, B1)", async () => {
  /* Chrome's recognizer ends takes on its own: no-speech after ~8s of
     silence, network, service-not-allowed. Neither stop() nor cancel()
     reaches the recorder then — the meter must release anyway, or the mic
     indicator stays lit for a dead take. */
  const { Ctor, instances } = fakeSpeechRecognition();
  const { stream, tracks } = meterStreamOf();
  const rec = recognitionRecorder(Ctor, { getUserMedia: async () => stream as never });
  rec.start();
  await tick(1);
  assert.equal(rec.levelStream(), stream, "metering live while the take runs");
  instances[0]!.onerror?.({ error: "no-speech" });
  assert.equal(rec.levelStream(), null, "the meter releases when the recognizer errors");
  assert.equal(tracks[0]!.stopped, true, "tracks stopped — mic indicator clears");
  instances[0]!.onend?.(); // browsers fire onend after onerror; release is idempotent
  assert.equal(rec.levelStream(), null);
});

test("recognition recorder: onend alone (recognizer-ended take) releases the meter", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const { stream, tracks } = meterStreamOf();
  const rec = recognitionRecorder(Ctor, { getUserMedia: async () => stream as never });
  rec.start();
  await tick(1);
  instances[0]!.onend?.(); // recognizer ended the take by itself
  assert.equal(rec.levelStream(), null, "no live meter for a dead take");
  assert.equal(tracks[0]!.stopped, true);
});

test("recognition recorder: a synchronous start failure never leaks the metering grant", async () => {
  /* if constructing/starting the recognizer throws, the controller moves to
     error without ever calling stop/cancel — a late metering grant must
     still be released, not held until page reload */
  class Throwing {
    lang = ""; continuous = false; interimResults = false;
    onresult: unknown = null; onerror: unknown = null; onend: unknown = null;
    start() { throw new Error("recognizer unavailable"); }
  }
  const { stream, tracks } = meterStreamOf();
  let grant: ((s: MediaStreamLike) => void) | undefined;
  const rec = recognitionRecorder(Throwing as never, { getUserMedia: () => new Promise<MediaStreamLike>((r) => { grant = r; }) });
  assert.throws(() => rec.start(), /recognizer unavailable/);
  grant?.(stream); // the metering grant lands after the throw
  await tick(1);
  assert.equal(rec.levelStream(), null, "no stream exposed for a take that never started");
  assert.equal(tracks[0]!.stopped, true, "the late grant is released, not leaked");
});

test("recognition recorder: a new take after an error never inherits a stale live meter", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const a = meterStreamOf();
  const b = meterStreamOf();
  const grants = [a.stream as never, b.stream as never];
  const rec = recognitionRecorder(Ctor, { getUserMedia: async () => grants.shift()! });
  rec.start();
  await tick(1);
  assert.equal(rec.levelStream(), a.stream);
  instances[0]!.onerror?.({ error: "network" });
  instances[0]!.onend?.();
  rec.start(); // take 2
  await tick(1);
  assert.equal(rec.levelStream(), b.stream, "the fresh take's meter is live");
  assert.equal(a.tracks[0]!.stopped, true, "the errored take's stream was stopped, not overwritten live");
  rec.cancel?.();
  assert.equal(b.tracks[0]!.stopped, true);
  assert.equal(rec.levelStream(), null);
});

/* ── issue #201: live transcription — the recognition path streams ── */

test("recognition recorder: interims stream as the live text-so-far; the take's final replaces them", async () => {
  /* the contract behind voiceInput.test.ts's read-through: continuous +
     interimResults are ON, and every non-final result flows out the
     onPartial sink as settled-phrases-plus-current-interim, so the draft
     can mirror the whole take dimmed until the final lands */
  const { Ctor, instances } = fakeSpeechRecognition();
  const rec = recognitionRecorder(Ctor);
  const partials: string[] = [];
  rec.onPartial = (t) => partials.push(t);
  rec.start();
  const r = instances[0]!;
  assert.equal(r.continuous, true, "continuous: a phrase ending doesn't end the take");
  assert.equal(r.interimResults, true, "interim results enabled — partials while speaking");

  type FakeResult = { isFinal: boolean; 0: { transcript: string } };
  const fire = (resultIndex: number, results: FakeResult[]) =>
    (r.onresult as (e: { resultIndex: number; results: ArrayLike<FakeResult> }) => void)({ resultIndex, results });

  fire(0, [{ isFinal: false, 0: { transcript: "the cat" } }]);
  fire(0, [{ isFinal: false, 0: { transcript: "the cat sat" } }]);
  assert.deepEqual(partials, ["the cat", "the cat sat"], "the live words stream while speaking");

  fire(0, [
    { isFinal: true, 0: { transcript: "the cat sat" } },
    { isFinal: false, 0: { transcript: " on the" } },
  ]);
  assert.deepEqual(partials.at(-1), "the cat sat on the", "settled phrases stay visible under the new interim");

  fire(1, [
    { isFinal: true, 0: { transcript: "the cat sat" } },
    { isFinal: true, 0: { transcript: " on the mat" } },
  ]);
  assert.deepEqual(partials.at(-1), "the cat sat on the mat", "a re-reported final (already counted) never doubles");

  const done = rec.stop();
  r.onend?.();
  assert.equal(await done, "the cat sat on the mat", "the take's final is exactly the accumulated text");
});

test("recognition recorder: a take with no partial subscription still works (the seam is optional)", async () => {
  const { Ctor, instances } = fakeSpeechRecognition();
  const rec = recognitionRecorder(Ctor);
  assert.equal(rec.onPartial, undefined, "no sink until the controller subscribes");
  rec.start();
  const r = instances[0]!;
  const fire = (r.onresult as (e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void);
  fire({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "hello" } }] });
  fire({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "hello" } }] });
  const done = rec.stop(); // the fake's stop() fires onend synchronously
  assert.equal(await done, "hello", "the final lands with no partial listener attached");
});

/* ── issue #201, audit round 1 (B1): stop()'s null contract ── */

test("stop() resolves null whenever no transcript lands — empty, cancelled, failed", async () => {
  /* the controller doc promises null for takes that produce no transcript;
     the amendment test pins only the non-null resolve */
  const empty = createVoiceInput({ transcribe: async () => "   ", onText: () => {} });
  empty.start();
  assert.equal(await empty.stop(), null, "an empty take resolves null");
  assert.equal(empty.state(), "idle", "an empty take is not an error");

  const resolvers: ((s: string) => void)[] = [];
  const cancelled = createVoiceInput({
    transcribe: () => new Promise<string>((r) => resolvers.push(r)),
    onText: () => {},
  });
  cancelled.start();
  const p = cancelled.stop();
  await tick(5);
  cancelled.cancel(); // user bails mid-transcribe
  resolvers[0]?.("discarded");
  assert.equal(await p, null, "a take cancelled mid-transcribe resolves null");

  const failed = createVoiceInput({
    transcribe: async () => {
      throw new Error("stt down");
    },
    onText: () => {},
  });
  failed.start();
  assert.equal(await failed.stop(), null, "a failed take resolves null");
  assert.equal(failed.state(), "error");
});
