import { baseHarness } from "./format";

/**
 * The harness-native resume command (issue #131): the id truss shows is
 * TRUSS's own — the harness knows the session by its harness_ref, and each
 * harness's CLI has its own direct-resume form (pi's `--resume` takes NO
 * argument — it's the picker; the direct form is `--session <id>`, vendored
 * docs cli.md:87-90; dsh resumes through the tui profile, args.ts).
 *
 * Only harnesses whose CLI resume form we have verified from their own
 * docs/source get a command — never fabricate one for an unknown CLI. No
 * ref, no command: a fake affordance is worse than none.
 *
 * The command runs ON the host the session lives on, so a remote harness id
 * ("pi@<hostId>") resolves to the same command as the local one.
 */

/** uuid-shaped refs (the only kind harnesses issue today) interpolate bare */
const SAFE_REF = /^[A-Za-z0-9._-]+$/;

/**
 * The command to paste on the session's own host, or null when there is no
 * verified form (unknown harness, no ref) or the ref can't be made safe.
 */
export function resumeCommand(harness: string, harnessRef: string | null | undefined): string | null {
  const ref = harnessRef?.trim();
  if (!ref || !harness.trim()) return null;

  /* never build an injectable command: shell-hostile refs are single-quote
     wrapped; a ref carrying its own quote is refused outright */
  const arg = SAFE_REF.test(ref) ? ref : ref.includes("'") ? null : `'${ref}'`;
  if (!arg) return null;

  switch (baseHarness(harness)) {
    case "pi":
      return `pi --session ${arg}`;
    case "dsh":
      return `dsh tui --resume ${arg}`;
    default:
      return null;
  }
}
