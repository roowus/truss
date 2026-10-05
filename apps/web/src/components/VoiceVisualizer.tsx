/* Live mic-level bars for an active dictation take (issue #112). Rides the
   capture seam: the recorder lends its granted stream via levelStream()
   (voice.ts), an AnalyserNode turns it into time-domain byte frames, and
   levelBars() smooths them into bar heights.

   The stream is only borrowed: the recorder releases it on stop/cancel, and
   this component tears its audio nodes down as soon as the getter reads
   null (or on unmount), so the visualizer never keeps the mic alive. The
   AudioContext factory is injectable like the capture's platform pieces;
   when the browser has no AudioContext or the recorder exposes no stream
   (the SpeechRecognition path), the bars simply stay calm. */

import { useEffect, useRef, type CSSProperties } from "react";
import { levelBars } from "@/lib/voiceLevel";
import type { MediaStreamLike } from "@/lib/voice";

const EMPTY = new Uint8Array(0);
const FLOOR = 0.15; // resting bar height as a fraction — calm, not absent

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
  const bars = props.bars ?? 10;
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const mkCtx = props.createAudioContext ?? defaultAudioContext;
    let ctx: AudioContext | null = null;
    let src: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let buf: Uint8Array<ArrayBuffer> | null = null;
    let attached: MediaStreamLike | null = null;
    let prev: number[] | undefined;
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
      attached = null;
      prev = undefined;
      const c = ctx;
      ctx = null;
      if (c) void c.close().catch(() => {});
    };

    const paint = (heights: number[]) => {
      const kids = el.children;
      for (let i = 0; i < heights.length && i < kids.length; i++) {
        (kids[i] as HTMLElement).style.transform = `scaleY(${FLOOR + heights[i] * (1 - FLOOR)})`;
      }
    };

    const tick = () => {
      const s = props.levelStream();
      if (!s) {
        /* no live take (or no stream support): glide the bars to rest */
        if (attached) detach();
        paint(levelBars(EMPTY, bars, prev));
        prev = undefined; // fully at rest — next attach starts calm
      } else {
        if (s !== attached) {
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
          } catch {
            detach();
          }
        }
        if (analyser && buf) {
          analyser.getByteTimeDomainData(buf);
          prev = levelBars(buf, bars, prev);
          paint(prev);
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
    <span ref={host} aria-hidden="true" className={props.className ?? "inline-flex items-center gap-[2px] h-3 shrink-0"}>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={bar} className="block w-[2.5px] h-full rounded-full bg-current origin-center" />
      ))}
    </span>
  );
}
