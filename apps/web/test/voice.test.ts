import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTranscript, transcribeAudio } from "../src/lib/voice";

/* Companion tests for the DOM-side voice wiring (issue #15) — the pure
   parts: draft appending and the server-route STT boundary. The state
   machine itself is pinned by voiceInput.test.ts. */

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
