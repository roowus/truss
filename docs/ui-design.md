# Truss UI design contract

> **SUPERSEDED (2026-09-24).** The v11 "Nocturne Abyss" direction was the locked design through M1. The shipped UI is a ground-up rebuild ("graphite & signal") by another author with full creative freedom. See `docs/ui-handoff.md` for what holds now (contract vs canvas). This file stays as the record of that iteration.

Reference implementation: `docs/mockups/variant-11-nocturne-abyss.html`. This file was the source of truth for that pass; the web app had to match it.

## Theme: Dracula at night

| Token | Hex | Use |
|---|---|---|
| `--bg-deep` | `#0c0d12` | window chrome, status bar |
| `--bg-side` | `#101118` | sidebar |
| `--bg-pane` | `#15161e` | inactive window |
| `--bg-focus` | `#1a1b24` | focused window (lightest) |
| `--bg-inset` | `#0f1016` | composer/footer wells |
| `--fg` | `#e9e9f4` | primary text |
| `--com` | `#6272a4` | secondary text |
| `--com-dim` | `#3f4a78` | tertiary text |
| `--cyan` | `#8be9fd` | links, tool names, live accents |
| `--purple` | `#bd93f9` | primary accent, active states, splitters on hover |
| `--pink` | `#ff79c6` | agent identity, subagent marks |
| `--orange` | `#ffb86c` | retries, warnings, inline code |
| `--red` | `#ff5555` | errors, deletions |
| `--hair` | `rgba(98,114,164,.14)` | hairline dividers |
| `--hover` | `rgba(98,114,164,.13)` | hover bubble |

Context gauge categories: system=comment, tools=purple, rules=cyan, memory=orange, conversation=pink.

## Typography

- UI text: Inter (Inter Tight for the wordmark). Numbers get their flavor from OpenType `tnum`/`zero`/`cv11`, never from a second family.
- Terminal and code/diff only: JetBrains Mono.
- Hierarchy by weight: 400 body, 500 labels, 600 data, 700 uppercase eyebrows.

## Patterns (locked at the time)

- **Windows**: Dockview groups. Each has its own tab bar. The active tab lifts to the pane's body color; the strip sits on a darker recess.
- **Splitters**: 1px seams, invisible at rest. Hover target extends ±3px. Purple on hover/drag. No visible track, no layout gap.
- **Hover affordance**: every clickable gets a soft `--hover` bubble. No glow anywhere.
- **Composer dock**: status-stack card, then the input well, then the context-chip strip. Chips are pill controls with icon + value + caret.
- **Scaffold rows**: tool calls and thinking rest at 67% opacity, lift to 100% on hover.
- **Run summary**: present-tense verbs ("Editing 2 files, explored 5 files, ran 3 commands").
- **Chat timeline rail**: a right-edge tick per user turn; click to jump.
- **Trajectory**: time-axis ruler, per-call latency bars, expandable tool rows; call/error/subagent marks on the ruler.
- **Sidebar**: Chrome-style project groups (color chip, caret, count). Harness logo chips with hover tooltips, placeholder chip when no logo.
- **Unfocused panes** recede as one layer (`opacity .78 · saturate(.75)`).
- No "·" separators; minimal pane-header text (title + actions only).
- `prefers-reduced-motion` respected globally.
