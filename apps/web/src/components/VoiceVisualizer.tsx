/* Live mic waveform for an active dictation take (issue #112) — the Voice
   Memos / iMessage look: a strip of bars scrolling left, newest amplitude
   at the right edge. Rides the capture seam: the recorder lends its granted
   stream via levelStream() (voice.ts), an AnalyserNode turns it into
   time-domain byte frames, and levelBars()/pushLevel() (voiceLevel.ts) do
   the pure smoothing and history bookkeeping.

   The stream is only borrowed: the recorder releases it on stop/cancel, and
   this component tears its audio nodes down as soon as the getter reads
   null (or on unmount), so the visualizer never keeps the mic alive. The
   AudioContext factory is injectable like the capture's platform pieces.

   Honesty rule: the bars render ONLY while a real stream is attached —
   the capture's own stream on the MediaRecorder path, or the metering-only
   getUserMedia the recognition path opens for exactly this purpose
   (voice.ts). If no stream can be had (metering denied, no device, a
   failed attach), the component stays hidden — parked "calm" bars are the
   silence signal and would lie to the user while they speak (audit round
   1, finding I2). */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { levelBars, pushLevel } from "@/lib/voiceLevel";
import type { MediaStreamLike } from "@/lib/voice";

const FLOOR = 0.12; // resting bar height as a fraction — calm, not absent
const SAMPLE_EVERY = 3; // push a history bar every Nth frame (~50ms → ~2s strip)

function defaultAudioContext(): AudioContext {
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("this browser has no AudioContext");
  return new Ctor();
}

export function VoiceVisualizer(props: {
  /** polled each frame: the live take's stream, or null */
  levelStream: () => MediaStreamLike | null;
  bars?: number;
  createAudioContext?: () => AudioContext;
  className?: string;
}) {
  const bars = props.bars ?? 40;
  const host = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const mkCtx = props.createAudioContext ?? defaultAudioContext;
    let ctx: AudioContext | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let buf: Uint8Array<ArrayBuffer> | null = null;
    let attached: MediaStreamLike | null = null;
    let failed = false; // one failed attach is final — no 60fps throw/catch churn
    let prevEnv: number[] | undefined; // levelBars smoothing state (single envelope channel)
    let history: number[] = []; // recent smoothed envelopes, newest last
    let frame = 0;
    let raf = 0;

    const detach = () => {
      try {
        src?.disconnect();
      } catch {
        /* already torn down */
      }
      try {
        analyser?.disconnect();
      } catch {
        /* already torn down */
      }
      src = null;
      analyser = null;
      buf = null;
      if (attached) setLive(false);
      attached = null;
      prevEnv = undefined;
      history = [];
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => {});
    };

    const paint = () => {
      /* right-align the history: empty slots on the left rest at the floor */
      const kids = el.children;
      const off = bars - history.length;
      for (let i = 0; i < bars && i < kids.length; i++) {
        const h = i >= off ? history[i - off] : 0;
        (kids[i] as HTMLElement).style.transform = `scaleY(${FLOOR + (h ?? 0) * (1 - FLOOR)})`;
      }
    };

    const tick = () => {
      const s = props.levelStream();
      if (!s) {
        if (attached) detach(); // the take released the mic — hide and let go
      } else if (s !== attached && !failed) {
        detach();
        try {
          ctx = mkCtx();
          void ctx.resume().catch(() => {}); // a take starts from a click, but resume is cheap insurance
          src = ctx.createMediaStreamSource(s as unknown as MediaStream);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser); // analysis only — never routed to the speakers
          buf = new Uint8Array(analyser.fftSize);
          attached = s;
          setLive(true);
        } catch {
          detach();
          failed = true; // stay hidden rather than retry every frame
        }
      }
      if (analyser && buf) {
        analyser.getByteTimeDomainData(buf);
        /* one smoothed envelope per frame; the strip samples it ~20×/s so
           the scroll reads as speech, not as a 60fps blur */
        prevEnv = levelBars(buf, 1, prevEnv);
        if (++frame % SAMPLE_EVERY === 0) {
          history = pushLevel(history, prevEnv[0] ?? 0, bars);
          paint();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      detach();
    };
  }, [props.levelStream, props.createAudioContext, bars]);

  const bar: CSSProperties = { transform: `scaleY(${FLOOR})` };
  return (
    /* always mounted (the rAF loop needs the node) but hidden until a real
       stream attaches — no false silence signal on streamless paths */
    <span
      ref={host}
      aria-hidden="true"
      style={live ? undefined : { display: "none" }}
      className={props.className ?? "inline-flex items-center gap-[1px] h-3 shrink-0"}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={bar} className="block w-[2px] h-full rounded-full bg-current origin-center" />
      ))}
    </span>
  );
}
