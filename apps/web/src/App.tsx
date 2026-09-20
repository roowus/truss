import { useEffect, useState } from "react";

/** M0 shell — proves the server link and renders the frame. Panels land in M1+. */
export function App() {
  const [health, setHealth] = useState<string>("connecting…");

  useEffect(() => {
    fetch("/health")
      .then((r) => r.json())
      .then((j) => setHealth(j.ok ? "connected" : "error"))
      .catch(() => setHealth("offline"));
  }, []);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-deep)",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--hair)",
          fontFamily: "'Inter Tight', Inter, sans-serif",
          fontWeight: 600,
          fontSize: 15,
        }}
      >
        truss<span style={{ color: "var(--purple)" }}>_</span>
      </header>
      <main
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          color: "var(--com)",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 14 }}>universal harness head — scaffold</div>
        <div style={{ fontSize: 11, fontFeatureSettings: '"tnum"' }}>
          server: <b style={{ color: "var(--fg)" }}>{health}</b>
        </div>
      </main>
    </div>
  );
}
