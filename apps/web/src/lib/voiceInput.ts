/* Voice-to-input core (issue #15) — a pure, DOM-free take controller.

   One take runs idle → recording → transcribing → idle. The transcript lands
   via onText (the composer draft) exactly once per take, trimmed; sending is
   never the controller's business. Audio capture and speech-to-text are both
   injected: the browser wires a MediaRecorder/SpeechRecognition recorder and
   a server/browser transcribe fn; tests wire fakes.

   Rules (pinned by apps/web/test/voiceInput.test.ts):
   - start() while recording/transcribing is a no-op (no double-mic);
   - recordings auto-stop at maxDurationMs and still land;
   - cancel() aborts the take: no STT call from a cancelled recording, no
     text, straight back to idle — a late STT result is discarded;
   - a failed take lands in "error" with the message, inserts nothing, and
     the controller can start again;
   - a recorder with a partial stream (issue #201) reports the live
     text-so-far mid-take; the controller forwards it to onPartial while
     the take records. Partials are display-only: the transcript still
     lands via onText exactly once, replacing them, and stop() resolves
     with it. */

export type VoiceState = "idle" | "recording" | "transcribing" | "error";

/** Audio capture, injected by the DOM side. stop() resolves with whatever
    payload transcribe() understands (Blob, a recognized string, …). */
export interface VoiceRecorder {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  /** release the mic without producing audio (cancel path) */
  cancel?(): void;
  /** the live capture stream while a take runs, for UI level metering
      (issue #112); null when unsupported or no take is live. Opaque here —
      the DOM side types it (MediaStreamLike in voice.ts). */
  levelStream?(): unknown;
  /** the interim transcript sink (issue #201): while a take records, the
      recorder reports the live text-so-far here. The controller subscribes
      on start() when built with onPartial and clears it when the take
      settles. Display-only — the transcript itself still lands via stop()'s
      audio payload + transcribe, exactly once per take. */
  onPartial?: ((text: string) => void) | undefined;
}

export interface VoiceInputDeps {
  transcribe: (audio: unknown) => Promise<string>;
  onText: (text: string) => void;
  /** live interim text while a take records (issue #201) — the draft shows
      it dimmed until the final lands via onText and replaces it */
  onPartial?: (text: string) => void;
  /** recordings auto-stop after this many ms (optional) */
  maxDurationMs?: number;
  recorder?: VoiceRecorder;
  /** state observer for the UI (the button colors itself off this) */
  onState?: (state: VoiceState) => void;
}

export interface VoiceController {
  state(): VoiceState;
  /** the failure message while state() === "error", else null */
  error(): string | null;
  start(): void;
  /** ends the take; resolves with the final transcript when one lands,
      null when the take was empty, cancelled, or failed (issue #201) */
  stop(): Promise<string | null>;
  cancel(): void;
  /** the recorder's live capture stream (opaque), or null — see
      VoiceRecorder.levelStream */
  levelStream(): unknown;
}

export function createVoiceInput(deps: VoiceInputDeps): VoiceController {
  let state: VoiceState = "idle";
  let errorMsg: string | null = null;
  let take = 0; // generation counter — cancel() invalidates in-flight work
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<string | null> | null = null; // the running take, for stop() waits

  const setState = (s: VoiceState) => {
    state = s;
    deps.onState?.(s);
  };

  const clearCap = () => {
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
  };

  /* the partial subscription dies with its take (issue #201) — a settled or
     cancelled recorder must never report into the next take's draft */
  const clearPartial = () => {
    if (deps.recorder) deps.recorder.onPartial = undefined;
  };

  const fail = (gen: number, e: unknown) => {
    if (gen !== take) return;
    clearPartial();
    errorMsg = e instanceof Error ? e.message : String(e);
    setState("error");
  };

  /* recording/transcribing → settled (idle or error). Stale generations
     (cancelled takes) drop out silently at every await boundary. Resolves
     with the final transcript, or null when the take produced none. */
  async function runTake(gen: number): Promise<string | null> {
    let audio: unknown;
    if (deps.recorder) {
      try {
        audio = await deps.recorder.stop();
      } catch (e) {
        fail(gen, e);
        return null;
      }
      if (gen !== take) return null;
    }
    setState("transcribing");
    try {
      const text = (await deps.transcribe(audio)).trim();
      if (gen !== take) return null; // cancelled while STT ran — discard
      errorMsg = null;
      if (text) deps.onText(text); // an empty take inserts nothing
      setState("idle");
      return text || null;
    } catch (e) {
      fail(gen, e);
      return null;
    }
  }

  function beginStop(gen: number): Promise<string | null> {
    /* re-entry guard: state only becomes "transcribing" after the recorder
       settles, so a double-click or the cap timer can land inside that
       window — a second runTake on the same take would transcribe and
       deliver the transcript twice */
    if (inflight) return inflight;
    clearCap();
    const p = runTake(gen).finally(() => {
      clearPartial();
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  return {
    state: () => state,
    error: () => errorMsg,
    levelStream: () => deps.recorder?.levelStream?.() ?? null,

    start() {
      if (state === "recording" || state === "transcribing") return; // no double-mic
      take++;
      const gen = take;
      errorMsg = null;
      setState("recording");
      /* live partials (issue #201): subscribe to the recorder's interim
         stream for exactly this take — the generation + state guard keeps
         a stale take's late partials out of a fresh take's draft */
      if (deps.recorder && deps.onPartial) {
        deps.recorder.onPartial = (t) => {
          if (gen === take && state === "recording") deps.onPartial?.(t);
        };
      }
      const cap = deps.maxDurationMs;
      if (cap !== undefined && cap > 0) {
        capTimer = setTimeout(() => {
          if (take === gen && state === "recording") void beginStop(gen);
        }, cap);
      }
      try {
        const started = deps.recorder?.start();
        if (started) Promise.resolve(started).catch((e) => {
          /* the take may already be over (a fast stop() while the mic
             prompt was up): a late capture failure only matters while this
             take is still the recording one */
          if (take !== gen || state !== "recording") return;
          clearCap();
          fail(gen, e);
        });
      } catch (e) {
        clearCap();
        fail(gen, e);
      }
    },

    stop(): Promise<string | null> {
      if (state === "recording") return beginStop(take);
      if (state === "transcribing" && inflight) return inflight; // wait out the take
      return Promise.resolve(null);
    },

    cancel() {
      take++; // invalidate whatever is in flight
      clearCap();
      clearPartial();
      /* detach a still-settling take: its promise resolves on its own (the
         generation check discards the result), and the NEXT take's stop()
         must not be handed this stale promise by the re-entry guard */
      inflight = null;
      if (state === "recording") deps.recorder?.cancel?.();
      // a transcription already running can't be aborted — its result is
      // discarded by the generation check instead
      errorMsg = null;
      if (state !== "idle") setState("idle");
    },
  };
}
