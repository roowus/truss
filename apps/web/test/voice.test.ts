import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTranscript, createBrowserVoiceInput, mediaRecorderCapture, transcribeAudio, type MediaRecorderLike, type MediaStreamLike } from "../src/lib/voice";
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
