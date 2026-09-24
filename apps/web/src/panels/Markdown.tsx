import { memo, type ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k} className="t-icode">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k} className="text-[var(--t-fg)] font-semibold">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("[")) {
      const mm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(<a key={k} href={mm[2]} target="_blank" rel="noreferrer" className="text-[var(--t-sky)] underline decoration-dotted underline-offset-2">{mm[1]}</a>);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Streaming-safe: an unterminated ``` fence renders as an open code block. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <div key={k++} className="t-codeblock">
          {lang && <div className="t-codelang">{lang}</div>}
          <pre><code>{body.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(
        <ul key={k++} className="t-ul">
          {items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(
        <ol key={k++} className="t-ol">
          {items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}
        </ol>,
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      blocks.push(<div key={k++} className="t-h">{inline(h[2], `h${k}`)}</div>);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|\s*[-*]\s+|\s*\d+[.)]\s+|#{1,4}\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{inline(para.join("\n"), `p${k}`)}</p>);
  }
  return <div className="t-md">{blocks}</div>;
});
