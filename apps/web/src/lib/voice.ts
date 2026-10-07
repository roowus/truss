/* DOM wiring for voice takes (issue #15) — everything browser-ish the
   DOM-free voiceInput core needs: mic capture plus the STT boundary.

   Two take strategies, picked once when the controller is built:
   - the browser's own SpeechRecognition (Chrome/Edge/Safari): zero config,
     it captures AND transcribes, so the "audio" payload is the transcript
     itself and transcribe() just passes it through;
   - MediaRecorder capture + POST /api/transcribe: the operator-configured
     speech endpoint, the only path where SpeechRecognition is absent (the
     Tauri desktop shell, Firefox). */

import { createVoiceInput, type VoiceController, type VoiceRecorder, type VoiceState } from "./voiceInput";

/* minimal SpeechRecognition shape — the DOM lib doesn't ship these types */
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* SpeechRecognition-backed take: start() opens the mic in the browser's own
   recognizer, stop() ends capture and resolves with the final transcript.
   The promise rejects via onerror (denied mic, no speech service, …).

   The recognizer runs continuous + interimResults (issue #201): phrases
   don't end the take mid-dictation, and every non-final result streams out
   through the onPartial sink as the live text-so-far (settled phrases plus
   the words still being recognized) — the draft mirrors it dimmed until the
   take's final lands and replaces it. The final remains the one transcript
   (the #15 rule): partials never reach transcribe()/onText.

   The recognizer owns its audio and exposes no stream, so without help the
   dictation visualizer (issue #112) would have nothing to read on this
   path — Chrome/Edge/Safari, the majority. So a take ALSO opens a
   metering-only getUserMedia (injected, optional): same mic permission as
   the recognizer's own prompt, analysis only, never recorded or played.
   Its lifetime mirrors the capture's generation guard — a take cancelled
   or stopped while the grant is pending releases the late stream and
   exposes nothing. If metering fails (denied, no device), the take is
   unaffected; the visualizer just stays hidden. */
export function recognitionRecorder(
  Ctor: SpeechRecognitionCtor,
  deps: { getUserMedia?: () => Promise<MediaStreamLike> } = {},
): LevelStreamingRecorder {
  let rec: SpeechRecognitionLike | null = null;
  let settle: { res: (t: string) => void; rej: (e: Error) => void } | null = null;
  let result: Promise<string> | null = null;
  let meter: MediaStreamLike | null = null;
  let meterGen = 0;
  let partialSink: ((text: string) => void) | undefined;
  const releaseMeter = () => {
    meterGen++; // invalidate a pending grant, same guard as the capture path
    meter?.getTracks().forEach((t) => t.stop());
    meter = null;
  };
  return {
    levelStream: () => meter,
    /* the controller (voiceInput) owns the subscription: it assigns the
       sink on start() and clears it when the take settles */
    get onPartial() {
      return partialSink;
    },
    set onPartial(fn) {
      partialSink = fn;
    },
    start() {
      /* the metering mic's lifetime must equal the take's, however the take
         ends — stop, cancel, the recognizer's own onerror/onend (Chrome's
         no-speech lands ~8s in), or a synchronous throw below. Every one of
         those paths releases it; a fresh start first sweeps any stale
         stream so it can never be overwritten live (audit round 5, B1). */
      releaseMeter();
      const myMeter = meterGen;
      if (deps.getUserMedia) {
        /* requested synchronously like the capture path, so a stop/cancel
           landing right after start() still wins the generation race */
        let pending: Promise<MediaStreamLike> | null = null;
        try {
          pending = deps.getUserMedia();
        } catch {
          /* no metering stream — the take still works, bars stay hidden */
        }
        pending?.then((s) => {
          /* the take ended while the metering prompt was up: release the
             just-granted mic instead of leaking it */
          if (myMeter !== meterGen) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          meter = s;
        }).catch(() => {
          /* no metering stream — the take still works, bars stay hidden */
        });
      }
      try {
        const r = new Ctor();
        rec = r;
        r.lang = navigator.language || "en-US";
        r.continuous = true;
        r.interimResults = true;
        let text = "";
        result = new Promise<string>((res, rej) => {
          settle = { res, rej };
        });
        r.onresult = (e) => {
          let interim = "";
          for (let i = 0; i < e.results.length; i++) {
            const res = e.results[i];
            if (!res) continue;
            /* finals persist in the results list once recognized — count
               only the ones new to this event, or every phrase lands twice */
            if (res.isFinal) {
              if (i >= e.resultIndex) text += res[0]?.transcript ?? "";
            } else {
              interim += res[0]?.transcript ?? "";
            }
          }
          /* the live text-so-far: settled phrases plus the words still
             being recognized (issue #201). Display-only — the take's final
             (text, at onend) replaces it in the draft. */
          partialSink?.(text + interim);
        };
        r.onerror = (e) => {
          releaseMeter(); // the take just died — the metering mic dies with it
          result?.catch(() => {}); // a rejection nobody may await must not crash
          const s = settle;
          settle = null;
          const msg = e.error === "not-allowed" ? "microphone access denied" : `speech recognition failed (${e.error ?? "unknown"})`;
          s?.rej(new Error(msg));
        };
        r.onend = () => {
          releaseMeter(); // onend fires on error paths too — idempotent
          const s = settle;
          settle = null;
          rec = null;
          s?.res(text);
        };
        r.start();
      } catch (e) {
        releaseMeter(); // construction/start threw: no take, no mic
        throw e;
      }
    },
    stop() {
      releaseMeter();
      try {
        rec?.stop(); // onend fires next with the final transcript
      } catch {
        /* never started */
      }
      return result ?? Promise.resolve("");
    },
    cancel() {
      releaseMeter();
      settle = null;
      result?.catch(() => {}); // nobody awaits it anymore — swallow a late rejection
      result = null;
      try {
        rec?.abort();
      } catch {
        /* never started */
      }
      rec = null;
    },
  };
}

/* MediaRecorder-backed take: raw capture; the transcript comes from the
   server route. stop() resolves with the recorded Blob.

   The platform pieces are injected (mediaRecorderCapture) so the startup
   races are testable in node — the cancel/stop-during-permission-prompt
   races below were audit findings B2 and B5. */

export interface MediaStreamLike {
  getTracks(): { stop(): void }[];
}
export interface MediaRecorderLike {
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

/* the MediaRecorder take also lends the granted stream to a visualizer
   (issue #112): levelStream() is null before start and after stop/cancel,
   the live stream while the take runs. The generation guard covers it too —
   a take cancelled mid-permission-prompt never assigns `stream`, so a stale
   take exposes nothing. */
export interface LevelStreamingRecorder extends VoiceRecorder {
  levelStream(): MediaStreamLike | null;
}

export function mediaRecorderCapture(deps: {
  getUserMedia: () => Promise<MediaStreamLike>;
  createRecorder: (stream: MediaStreamLike) => MediaRecorderLike;
}): LevelStreamingRecorder {
  let stream: MediaStreamLike | null = null;
  let rec: MediaRecorderLike | null = null;
  let chunks: Blob[] = [];
  /* generation counter for capture startup: getUserMedia can outlive the
     take (a slow permission prompt), and stop() OR cancel() landing in that
     window must invalidate the pending start — otherwise its late
     continuation starts a recording into a take nobody will stop, and the
     mic stays live until unmount (audit findings B2 and B5). Per-generation
     rather than a flag so overlapping startups can't clear each other's
     invalidation. */
  let gen = 0;
  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    rec = null;
  };
  return {
    levelStream: () => stream,
    async start() {
      const my = ++gen;
      const s = await deps.getUserMedia();
      /* the take ended while the prompt was up: release the just-granted
         mic instead of starting an orphaned recording */
      if (my !== gen) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      chunks = [];
      rec = deps.createRecorder(s);
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.start();
    },
    stop() {
      const r = rec;
      if (!r) {
        gen++; // capture startup still pending: the take ends empty, and the late start is invalidated
        return Promise.resolve(new Blob());
      }
      return new Promise<Blob>((res) => {
        r.onstop = () => {
          const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
          release();
          res(blob);
        };
        try {
          r.stop();
        } catch {
          release();
          res(new Blob(chunks));
        }
      });
    },
    cancel() {
      gen++;
      if (rec) {
        try {
          rec.ondataavailable = null;
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
      release();
    },
  };
}

function mediaRecorder(): VoiceRecorder {
  return mediaRecorderCapture({
    getUserMedia: () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("this browser can't capture microphone audio");
      return navigator.mediaDevices.getUserMedia({ audio: true });
    },
    /* the DOM MediaRecorder is structurally compatible at runtime; its
       handler types are just wider than the seam's */
    createRecorder: (s) => new MediaRecorder(s as MediaStream) as unknown as MediaRecorderLike,
  });
}

/* the STT boundary: a string payload is already a transcript (browser
   recognition); a Blob goes to the operator-configured server route */
export async function transcribeAudio(audio: unknown): Promise<string> {
  if (typeof audio === "string") return audio;
  if (!(audio instanceof Blob) || audio.size === 0) return "";
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioBase64: btoa(bin), mime: audio.type || undefined }),
  });
  const data = (await res.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `transcription failed (${res.status})`);
  return typeof data.text === "string" ? data.text : "";
}

/** append a dictated take to the current draft, separating with one space */
export function appendTranscript(draft: string, transcript: string): string {
  const t = transcript.trim();
  if (!t) return draft;
  const d = draft.replace(/\s+$/, "");
  return d ? `${d} ${t}` : t;
}

/** the browser controller with the stream seam typed: the MediaRecorder
    path lends its live mic stream to the dictation visualizer (issue #112);
    the SpeechRecognition path meters via its own parallel getUserMedia.
    Either way it reads null whenever no take is live. */
export interface BrowserVoiceController extends VoiceController {
  levelStream(): MediaStreamLike | null;
}

/** build the composer controller: recognition where the browser has it,
    server transcription everywhere else. Never auto-sends — onText only
    touches the draft. onPartial (issue #201) streams the live text-so-far
    for the draft's dimmed listening display; the final replaces it. */
export function createBrowserVoiceInput(deps: { onText: (text: string) => void; onPartial?: (text: string) => void; onState?: (s: VoiceState) => void }): BrowserVoiceController {
  const SR = typeof window !== "undefined" ? speechRecognitionCtor() : null;
  const c = createVoiceInput({
    maxDurationMs: 60_000,
    onText: deps.onText,
    ...(deps.onPartial ? { onPartial: deps.onPartial } : {}),
    ...(deps.onState ? { onState: deps.onState } : {}),
    recorder: SR
      ? recognitionRecorder(SR, {
          /* metering-only stream for the visualizer (issue #112): the
             recognizer exposes no audio, so without this the bars would
             have nothing real to read on the majority path */
          getUserMedia: () => {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("no mic capture for metering");
            return navigator.mediaDevices.getUserMedia({ audio: true });
          },
        })
      : mediaRecorder(),
    transcribe: transcribeAudio,
  });
  return { ...c, levelStream: () => (c.levelStream() ?? null) as MediaStreamLike | null };
}
