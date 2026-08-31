# UI specs

Two kinds of file live here.

**[000 — The design system](000-design-system.md)** is the current state: every
token, the type scale, the radii, the surface levels, the motion tiers, the
component recipes, and the rules that keep them there. It is the one file that is
kept true. Read it first, and change it in the same commit as the code.

**Everything numbered above it is a record**, not a specification of the present.
Each was written before its change, states the problem it solved and the research
behind it, and is left alone afterwards. Where a value in one has since moved, it
carries an admonition at the top pointing here — and 000 wins.

**[IDEAS.ru.md](IDEAS.ru.md) is neither.** It is an unnumbered backlog: problems
found in the code and directions proposed for them, none of it decided. An entry
leaves it by acquiring a number, which is also when it acquires a research pass.

The rule this directory exists to enforce: a change a reader can see gets a spec
and a research pass first, and a change that moves a rule updates 000 and
`scripts/check-docpilot.sh` in the same commit.

## Index

| spec | what it changed |
|---|---|
| [000](000-design-system.md) | **the design system** — tokens, type, radius, elevation, motion, spacing, recipes, rules |
| [001](001-icon-sprite.md) | The icon set became an SVG `<symbol>` sprite; New chat became a compose glyph |
| [002](002-header-hairline.md) | The header's divider is absent at the top of the thread and appears on scroll |
| [003](003-history-dock.md) | Past conversations open **above** the thread, not below it |
| [004](004-button-system.md) | Text buttons became the pill/ghost system ChatGPT established |
| [005](005-fab-label.md) | The floating button carries a label; both label and icon are configurable |
| [006](006-row-controls.md) | Delete is a bin, not an `×`; a row and the control inside it separate |
| [007](007-quote-a-passage.md) | Selecting inside an answer offers **Ask AI**; the passage travels as its own field |
| [008](008-edit-a-question.md) | A question can be copied, rewritten and asked again — both truncate the thread; a pill leads back down a long one |
| [009](009-every-action-has-a-switch.md) | **rule 11** — every reader-visible action is removable and documented; sixteen switches, seventeen changes, four defects that get none |
| [010](010-a-turn-outlives-the-panel.md) | Closing the panel stops looking, not asking — the turn runs on and the trigger takes a dot |
| [011](011-the-panel-can-be-pinned.md) | `ui.theme` — a site can pin the panel light or dark instead of following the page |
| [012](012-nothing-is-lost-to-a-reload.md) | Leaving the page keeps what was written, what was typed, and says so while you wait |

## The rules

The table lives in [000 § The rules](000-design-system.md#the-rules), next to the
values it polices, and `scripts/check-docpilot.sh` implements it. Both move
together or neither does.
