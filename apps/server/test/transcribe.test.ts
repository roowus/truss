import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bootServer, type TestServer } from "./server-harness.js";

/* Tests for POST /api/transcribe — https://github.com/roowus/truss/issues/15
   ("Voice to input"). The route is a thin proxy to the operator-configured
   speech endpoint (TRUSS_TRANSCRIBE_URL et al.):

   - unconfigured → 501 with a clear operator-facing message (the web UI then
     surfaces it as the take's error state);
   - missing body → 400;
   - configured → multipart proxy: the audio bytes and the model field reach
     the endpoint, a bearer token rides along when set, and { text } comes
     back verbatim;
   - an upstream failure → 502 with the endpoint's message, never a hang. */

let srv: TestServer;
let stub: Server;
interface StubCapture { contentType: string; auth: string | undefined; body: Buffer }
const stubSeen: StubCapture[] = [];
let stubReply: { status: number; json: unknown } = { status: 200, json: { text: "hello world" } };

before(async () => {
  srv = await bootServer("transcribe");
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      stubSeen.push({
        contentType: String(req.headers["content-type"] ?? ""),
        auth: req.headers.authorization as string | undefined,
        body: Buffer.concat(chunks),
      });
      res.writeHead(stubReply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(stubReply.json));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
});

after(async () => {
  delete process.env.TRUSS_TRANSCRIBE_URL;
  delete process.env.TRUSS_TRANSCRIBE_MODEL;
  delete process.env.TRUSS_TRANSCRIBE_API_KEY;
  await new Promise((r) => stub.close(r));
  await srv.close();
});

const post = (body: unknown) =>
  fetch(`${srv.base}/api/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("unconfigured server answers 501 with a clear message", async () => {
  delete process.env.TRUSS_TRANSCRIBE_URL;
  const r = await post({ audioBase64: Buffer.from("fake-audio").toString("base64"), mime: "audio/webm" });
  assert.equal(r.status, 501);
  const body = (await r.json()) as { error?: string };
  assert.match(body.error ?? "", /TRUSS_TRANSCRIBE_URL/);
});

test("missing audioBase64 is a 400, not a crash", async () => {
  const r = await post({});
  assert.equal(r.status, 400);
  /* the 400 check runs before config matters, so also cover a configured
     server rejecting an empty take the same way */
  process.env.TRUSS_TRANSCRIBE_URL = stubUrl();
  const r2 = await post({ mime: "audio/webm" });
  assert.equal(r2.status, 400);
});

test("configured server proxies the take and returns the transcript", async () => {
  process.env.TRUSS_TRANSCRIBE_URL = stubUrl();
  process.env.TRUSS_TRANSCRIBE_MODEL = "test-ear-v2";
  process.env.TRUSS_TRANSCRIBE_API_KEY = "sekrit";
  stubReply = { status: 200, json: { text: "hello world" } };
  stubSeen.length = 0;

  const audio = Buffer.from("fake-audio-bytes");
  const r = await post({ audioBase64: audio.toString("base64"), mime: "audio/ogg" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: "hello world" });

  assert.equal(stubSeen.length, 1, "the stub endpoint saw a request");
  const seen = stubSeen[0];
  assert.match(seen.contentType, /^multipart\/form-data; boundary=/);
  const payload = seen.body.toString("latin1");
  assert.ok(payload.includes('name="model"'), "model field present");
  assert.ok(payload.includes("test-ear-v2"), "the configured model went out");
  assert.ok(payload.includes('name="file"; filename="take.ogg"'), "audio rides as a file part with a mime-derived extension");
  assert.ok(payload.includes("fake-audio-bytes"), "the audio bytes survive the round trip");
  assert.equal(seen.auth, "Bearer sekrit");
});

test("upstream failure surfaces as 502 with the endpoint's message", async () => {
  process.env.TRUSS_TRANSCRIBE_URL = stubUrl();
  stubReply = { status: 429, json: { error: "rate limited" } };
  const r = await post({ audioBase64: Buffer.from("x").toString("base64") });
  assert.equal(r.status, 502);
  const body = (await r.json()) as { error?: string };
  assert.match(body.error ?? "", /429/);
});

function stubUrl(): string {
  const addr = stub.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/audio/transcriptions`;
}
