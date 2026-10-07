/**
 * Deliverables guidance — the one canonical paragraph every harness session
 * hears at bootstrap (issue #203). A session told "write a report" must post
 * it to the user's feed, not leave it chat-only: pi/dsh/hermes append it to
 * the first prompt they send (no system-prompt channel there), claude
 * carries it via --append-system-prompt, and pi additionally gets real feed
 * tools via its shipped extension (pi has no MCP surface — see
 * piExtension.ts).
 */
export function deliverablesGuidance(): string {
  return (
    `Deliverables belong on the user's feed. When you finish research, analysis, a report, ` +
    `or any substantial work the user asked for, post the result with the post_feed tool: ` +
    `type "report" for finished work (one-line title, substance in the markdown body), ` +
    `type "note" for heads-ups the user should see soon. Never leave a deliverable in the ` +
    `chat transcript only — the feed is the user's inbox; work that isn't posted there is ` +
    `work the user never sees.`
  );
}

