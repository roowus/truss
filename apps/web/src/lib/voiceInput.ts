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
     the controller can start again. */

export type VoiceState = "idle" | "recording" | "transcribing" | "error";

/** Audio capture, injected by the DOM side. stop() resolves with whatever
    payload transcribe() understands (Blob, a recognized string, …). */
export interface VoiceRecorder {
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  /** release the mic without producing audio (cancel path) */
  cancel?(): void;
}

export interface VoiceInputDeps {
  transcribe: (audio: unknown) => Promise<string>;
  onText: (text: string) => void;
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
  stop(): Promise<void>;
  cancel(): void;
}

export function createVoiceInput(deps: VoiceInputDeps): VoiceController {
  let state: VoiceState = "idle";
  let errorMsg: string | null = null;
  let take = 0; // generation counter — cancel() invalidates in-flight work
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null; // the running take, for stop() waits

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

  const fail = (gen: number, e: unknown) => {
    if (gen !== take) return;
    errorMsg = e instanceof Error ? e.message : String(e);
    setState("error");
  };

  /* recording/transcribing → settled (idle or error). Stale generations
     (cancelled takes) drop out silently at every await boundary. */
  async function runTake(gen: number): Promise<void> {
    let audio: unknown;
    if (deps.recorder) {
      try {
        audio = await deps.recorder.stop();
      } catch (e) {
        fail(gen, e);
        return;
      }
      if (gen !== take) return;
    }
    setState("transcribing");
    try {
      const text = (await deps.transcribe(audio)).trim();
      if (gen !== take) return; // cancelled while STT ran — discard
      errorMsg = null;
      if (text) deps.onText(text); // an empty take inserts nothing
      setState("idle");
    } catch (e) {
      fail(gen, e);
    }
  }

  function beginStop(gen: number): Promise<void> {
    /* re-entry guard: state only becomes "transcribing" after the recorder
       settles, so a double-click or the cap timer can land inside that
       window — a second runTake on the same take would transcribe and
       deliver the transcript twice */
    if (inflight) return inflight;
    clearCap();
    const p = runTake(gen).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  return {
    state: () => state,
    error: () => errorMsg,

    start() {
      if (state === "recording" || state === "transcribing") return; // no double-mic
      take++;
      const gen = take;
      errorMsg = null;
      setState("recording");
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

    stop(): Promise<void> {
      if (state === "recording") return beginStop(take);
      if (state === "transcribing" && inflight) return inflight; // wait out the take
      return Promise.resolve();
    },

    cancel() {
      take++; // invalidate whatever is in flight
      clearCap();
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
