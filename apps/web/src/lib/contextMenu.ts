import type { BuiltInContextMenuItem, ReactContextMenuItemConfig } from "dockview-react";

export interface ContextMenuSpace {
  id: string;
  name: string;
}

/* The tab context menu's item list. The Copy-to / Move-to sections (and
   their separators) exist only when another space exists to send the tab
   to — a separator must never trail the list: once separators are visible
   it paints as a stray bar with padding under it (issue #172). */
export function tabContextMenuItems(opts: {
  others: ContextMenuSpace[];
  closeOthers?: () => void;
  copyTo: (spaceId: string) => void;
  moveTo: (spaceId: string) => void;
}): (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] {
  const items: (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] = [
    "close",
    opts.closeOthers ? { label: "Close Others", action: opts.closeOthers } : "closeOthers",
  ];
  if (opts.others.length) {
    items.push("separator");
    for (const s of opts.others) items.push({ label: `Copy to ${s.name}`, action: () => opts.copyTo(s.id) });
    items.push("separator");
    for (const s of opts.others) items.push({ label: `Move to ${s.name}`, action: () => opts.moveTo(s.id) });
  }
  return items;
}
