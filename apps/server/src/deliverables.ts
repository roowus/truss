/**
 * Deliverables guidance — the one canonical paragraph every harness session
 * hears at bootstrap (issue #203). A session told "write a report" must post
 * it to the user's feed, not leave it chat-only: pi/dsh/hermes append it to
 * the first prompt they send (no system-prompt channel there), claude
 * carries it via --append-system-prompt, and pi additionally gets real feed
 * tools via its shipped extension (pi has no MCP surface — see
 * piExtension.ts).
 *
 * Issue #222 adds the automation rule to the same paragraph: a session told
 * "set up a cron" reached for the OS (crontab, systemd timers, launchd)
 * instead of truss's own scheduler. The capability was always there —
 * schedule_task has been in the MCP since #16 — but nothing told the model,
 * so the reflex won. Same failure shape as #203.
 */
export function deliverablesGuidance(): string {
  return (
    `Deliverables belong on the user's feed. When you finish research, analysis, a report, ` +
    `or any substantial work the user asked for, post the result with the post_feed tool: ` +
    `type "report" for finished work (one-line title, substance in the markdown body), ` +
    `type "note" for heads-ups the user should see soon. Never leave a deliverable in the ` +
    `chat transcript only — the feed is the user's inbox; work that isn't posted there is ` +
    `work the user never sees. ` +
    `Automation belongs in truss too. When the user asks for recurring or scheduled work, ` +
    `use the schedule_task tool — board cards the user can see, control, and clear. Never ` +
    `reach for OS-level scheduling (crontab, systemd timers, launchd): entries there are ` +
    `invisible in truss, run outside the app's lifecycle, carry no run history, and the ` +
    `user cannot stop them from the board.`
  );
}

