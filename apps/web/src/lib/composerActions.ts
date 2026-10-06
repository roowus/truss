/**
 * The composer button bar's action model (issue #179: Stop belongs in the
 * composer — while a session runs, Send becomes Stop, and the header
 * carries no Stop of its own).
 *
 * composerActions({ running, queues, dead, sending })
 *   → { primary: "send" | "queue" | "stop" | "resume"; stop?: boolean }
 *
 * - idle → send;
 * - running, no queueing → the primary IS stop (Send becomes Stop);
 * - running WITH queueing → primary queue plus a stop alongside it, so the
 *   interrupt never disappears behind the queue affordance (the hole the
 *   old send→stop swap had: Queue showed and Stop lived only in the
 *   header);
 * - dead → resume (the existing wake-and-send).
 *
 * `sending` never changes the primary: an in-flight send keeps the bar on
 * its current action and the button disables itself instead, so a busy
 * draft can't double-act. Pure and deterministic — ChatPanel renders
 * straight from the result.
 */
export interface ComposerState {
  running: boolean;
  queues: boolean;
  dead: boolean;
  sending?: boolean;
}

export interface ComposerActions {
  primary: "send" | "queue" | "stop" | "resume";
  stop?: boolean;
}

export function composerActions({ running, queues, dead }: ComposerState): ComposerActions {
  if (dead) return { primary: "resume" };
  if (running) return queues ? { primary: "queue", stop: true } : { primary: "stop" };
  return { primary: "send" };
}
