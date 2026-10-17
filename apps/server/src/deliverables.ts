/**
 * Deliverables guidance — the canonical paragraph every harness session hears
 * at bootstrap (issue #203). A session told "write a report" must post it to
 * the user's feed, not leave it chat-only: pi/dsh/hermes append it to the
 * first prompt they send (no system-prompt channel there), claude carries it
 * via --append-system-prompt, and pi additionally gets real feed tools via
 * its shipped extension (pi has no MCP surface — see piExtension.ts).
 *
 * Issue #222 adds the automation rule to the same paragraph: a session told
 * "set up a cron" reached for the OS (crontab, systemd timers, launchd)
 * instead of truss's own scheduler. The capability was always there —
 * schedule_task has been in the MCP since #16 — but nothing told the model,
 * so the reflex won. Same failure shape as #203.
 *
 * The paragraph is harness-agnostic in its FEED half but not in its
 * AUTOMATION half: naming a tool the session cannot call is worse than
 * silence, because the model then either hallucinates the call or falls back
 * to the very OS path the same paragraph forbids (audit B1 on PR #240).
 * schedule_task lives on the truss MCP server, which only
 * claude-code/dsh/hermes attach (sessions.ts's MCP_ATTACHED; pi has no MCP
 * surface at all — see piExtension.ts). So the rule splits: every harness
 * carries the PROHIBITION (that is the issue's actual ask, and it is true
 * everywhere), while only the MCP-attached harnesses are told the tool name.
 * Each call site knows which harness it serves, so it picks its variant
 * directly: the MCP adapters (claude/dsh/hermes) call
 * `deliverablesGuidance()`, and pi's two bootstrap surfaces (`adapters/pi.ts`
 * and `POSTING_GUIDE_PI`) call `deliverablesGuidanceNoMcp()`. There is
 * deliberately no harness→variant selector here: the source of truth for
 * "which harnesses attach the MCP" is `sessions.ts`'s `MCP_ATTACHED`, and a
 * second copy in this module could drift out of step with it while a test
 * pinning the copy stayed green (audit round 2, B1).
 */
const AUTOMATION_PROHIBITION =
  `Automation belongs in truss too. Never reach for OS-level scheduling ` +
  `(crontab, systemd timers, launchd): entries there are invisible in truss, ` +
  `run outside the app's lifecycle, carry no run history, and the user ` +
  `cannot stop them from the board. `;

/* The feed half — harness-agnostic, so it is written once. Both variants
   below differ ONLY in the automation sentence, which is the one clause that
   depends on whether the harness can call schedule_task. */
const FEED_GUIDANCE =
  `Deliverables belong on the user's feed. When you finish research, analysis, a report, ` +
  `or any substantial work the user asked for, post the result with the post_feed tool: ` +
  `type "report" for finished work (one-line title, substance in the markdown body), ` +
  `type "note" for heads-ups the user should see soon. Never leave a deliverable in the ` +
  `chat transcript only — the feed is the user's inbox; work that isn't posted there is ` +
  `work the user never sees. `;

/**
 * The canonical paragraph for harnesses that attach the truss MCP server
 * (claude-code, dsh, hermes) — they can actually call `schedule_task`, so it
 * is named. See `deliverablesGuidanceNoMcp` for the pi variant.
 */
export function deliverablesGuidance(): string {
  return (
    FEED_GUIDANCE +
    AUTOMATION_PROHIBITION +
    `When the user asks for recurring or scheduled work, use the schedule_task tool — ` +
    `board cards the user can see, control, and clear.`
  );
}

/**
 * The same paragraph for harnesses WITHOUT the truss MCP (pi). Identical
 * except the automation sentence: pi cannot call `schedule_task`, so the
 * guidance forbids the OS path and points at the surface pi does have — tell
 * the user and describe the recurring task for them to schedule — instead of
 * naming a tool that would only fail with "unknown tool" (audit B1).
 */
export function deliverablesGuidanceNoMcp(): string {
  return (
    FEED_GUIDANCE +
    AUTOMATION_PROHIBITION +
    `You have no scheduling tool in this session, so do NOT create the automation ` +
    `yourself: say so and describe the recurring task for the user to schedule in truss.`
  );
}
