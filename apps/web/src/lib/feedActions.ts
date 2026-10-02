/**
 * The feed card's universal actions (issue #25): always the same four, in the
 * same order, with real labels and tooltips that say the outcome. Hit targets
 * and glyphs grow past the old 24px/11px smudges.
 */

export const CARD_ACTION_SIZE_PX = 28;
export const CARD_ACTION_ICON_PX = 13;

export interface CardActionSpec {
  id: "read" | "save" | "share" | "dismiss";
  icon: string;
  label: string;
  tooltip: string;
}

export function feedCardActions(item: { id: string; state: string }): CardActionSpec[] {
  const unread = item.state === "unread";
  const saved = item.state === "saved";
  return [
    {
      id: "read",
      icon: "check",
      label: unread ? "Mark read" : "Mark unread",
      tooltip: unread
        ? "Mark this card as read — it stays in the inbox but stops looking new"
        : "Mark this card unread — it returns to looking new so you don't lose it",
    },
    {
      id: "save",
      icon: "tag",
      label: saved ? "Unsave" : "Save",
      tooltip: saved ? "Remove this card from your saved list" : "Save this card so it survives inbox cleanups",
    },
    {
      id: "share",
      icon: "send",
      label: "Share",
      tooltip: "Send this card into another session's chat — the agent sees it and can act on it",
    },
    {
      id: "dismiss",
      icon: "x",
      label: "Dismiss",
      tooltip: "Remove this card from the inbox (it stays in the history)",
    },
  ];
}
