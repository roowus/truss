import { Icon, type IconName } from "../icons";

/** Placeholder for panels landing in later milestones (terminal M2, native panels M5). */
export function StubPanel({ title, icon, lands }: { title: string; icon: IconName; lands: string }) {
  return (
    <div className="stub">
      <div>
        <Icon name={icon} className="ic" />
        <div style={{ color: "var(--com)", fontWeight: 500 }}>{title}</div>
        <div>lands in {lands}</div>
      </div>
    </div>
  );
}
