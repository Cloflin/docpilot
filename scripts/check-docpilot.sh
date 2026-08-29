#!/usr/bin/env bash
# Design-direction rules — each one is checkable, so it is checked.
#
#   npm run check
#
# REPOSITORY-INTERNAL, and deliberately not shipped to consumers: every rule
# below asserts something about THIS package's own component source, which a
# consumer never edits. `package.json#files` therefore does not list scripts/.
#
# Two of the original rules — "no emoji" and the rule-4 token leak — have moved
# into the vitest suite instead. They are the two that are worth running on every
# platform, and `grep -P` does not exist in BSD grep, where the original's
# `2>/dev/null` turned a missing flag into a silent pass.
#
# THE STYLESHEET IS ONE CORE PLUS N ADAPTERS. Every counting rule reads ALL of
# them, because the way a split breaks a checker is not a rule that fails — it is
# a rule that passes while looking at half the code, or at a file that no longer
# exists. Hence the existence gate directly below: a renamed file must fail
# loudly here rather than make every count trivially true.
#
# `ADAPTERS` is the whole of what has to change when a host is added. It feeds
# rule 0, `SCSS_ALL` (and through it rules 1, 2, 5, 6 and 7) and the two
# per-adapter rules, 9a and 9b — so an adapter added to the list is examined by
# every rule at once, and one forgotten there is examined by none.

set -uo pipefail
cd "$(dirname "$0")/.."

VUE=src/theme/components/DocPilot.vue
CORE=src/theme/styles/core.scss
VPCSS=src/theme/styles/vitepress.scss
BREAKS=src/theme/styles/_breakpoints.scss
ENTRY=src/theme/styles/docpilot.scss
DOCUCSS=src/theme/styles/docusaurus.scss
ADAPTERS="$VPCSS $DOCUCSS"
SCSS_ALL="$CORE $ADAPTERS"
HARNESS=src/theme/docpilot/harness.js

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

printf '\nDocPilot design-direction checks\n\n'

# Rule 0 — every file a rule below reads exists and is not empty. Without this,
# a rename turns "0 borders" and "0 brand references" into passing rules.
missing=''
for f in "$VUE" "$CORE" $ADAPTERS "$BREAKS" "$ENTRY" "$HARNESS"; do
  [ -s "$f" ] || missing="$missing $f"
done
[ -z "$missing" ] && ok "rule 0 — every checked file exists and is non-empty" \
                  || bad "rule 0 — missing or empty:$missing"

# Rule 1 — THE HAIRLINE IS ONE PIXEL AND ONE COLOUR SOURCE.
#
# This used to be a BUDGET: count the resting borders, name the five selectors
# allowed to carry one. That was right for a design that carried structure in
# fills, where a border was an exception worth counting. It is not this design
# any more — the 1px `--dp-line` ring IS the structure, and the composer, the
# popup, the code card, the floating button and the four chrome bands all draw
# one. So the rule stops being a count and becomes a SHAPE.
#
# Four things are legal on a border declaration and nothing else:
#
#   border[-side]: 1px solid var(--dp-line)    the ring
#   border[-side]: 1px solid transparent       a ring reserved in the box model
#                                              and coloured by state (the header)
#   border[-side]: 1px solid CanvasText        forced-colors, where fills vanish
#   border: none  |  border: 0                 a reset
#
# and `border-color` may only name `--dp-line` or `transparent`.
#
# The named inventory lives in ui-specs/000-design-system.md, where each ring can
# carry the reason it exists. 1b prints it here anyway, so a reviewer still sees
# every one of them by name in the check output.
BORDER_RE='^[[:space:]]*border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?[[:space:]]*:'
BORDER_RESET=':[[:space:]]*(none|0);'

# 1a — every border is the ring, a reserved ring, a forced-colors ring, or a reset.
shape=$(cat $SCSS_ALL | grep -nE "$BORDER_RE" \
  | grep -vE "$BORDER_RESET" \
  | grep -vE ':[[:space:]]*1px solid (var\(--dp-line\)|transparent|CanvasText);' \
  | grep -vE 'border(-[a-z-]+)?-color:[[:space:]]*(var\(--dp-line\)|transparent);' \
  | tr '\n' ' ')
[ -z "$(echo "$shape" | tr -d ' ')" ] && ok "rule 1 — every border is 1px solid --dp-line / transparent / CanvasText" \
                                      || bad "rule 1 — border that is not the hairline: $shape"

# 1b — the ceiling, and the inventory. Generous, because the ring is a structural
# device now rather than an exception; stated, because a jump past it should be a
# deliberate edit to this file rather than a diff nobody counted.
rings=$(cat $SCSS_ALL | grep -E "$BORDER_RE" | grep -vcE "$BORDER_RESET" | tr -d ' ')
if [ "$rings" -le 20 ]; then
  ok "rule 1 — $rings rings"
  awk -v re="$BORDER_RE" -v reset="$BORDER_RESET" '
    FNR == 1 { sel = "" }
    /^[^ \t].*\{/ { sel = $0; sub(/[[:space:]]*\{.*/, "", sel) }
    $0 ~ re {
      if ($0 ~ reset) next
      decl = $0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", decl)
      printf "          %-30s %s\n", sel, decl
    }' $SCSS_ALL
else
  bad "rule 1 — $rings rings, expected <= 20"
fi

# 1c — every ring is on a selector this package owns. A border on `pre`, on a
# host class or on a bare element is a rule that would follow the panel into
# somebody else's page. `CanvasText` lives inside an @media, so it is exempt.
foreign=$(awk -v re="$BORDER_RE" -v reset="$BORDER_RESET" '
  FNR == 1 { sel = "" }
  /^[^ \t].*\{/ { sel = $0; sub(/[[:space:]]*\{.*/, "", sel) }
  $0 ~ re {
    if ($0 ~ reset || $0 ~ /CanvasText/) next
    if (sel ~ /^\.docpilot/) next
    print sel
  }' $SCSS_ALL | sort -u | tr '\n' ' ')
[ -z "$(echo "$foreign" | tr -d ' ')" ] && ok "rule 1 — every ring is on a .docpilot selector" \
                                        || bad "rule 1 — ring on a foreign selector: $foreign"

# 1d — OUTLINE IS FOCUS, NEVER AN EDGE. The composer and the feedback textarea
# used to draw their resting edge with a 2px outline, purely to stay out of the
# old budget. Both are real rings now, and this is what stops that workaround
# coming back: an outline may only be the focus indicator, the system highlight,
# or a reset.
edges=$(cat $SCSS_ALL | grep -nE '^[[:space:]]*outline[[:space:]]*:' \
  | grep -vE ':[[:space:]]*(none|0);' \
  | grep -vE ':[[:space:]]*2px solid (var\(--dp-focus\)|Highlight);' \
  | tr '\n' ' ')
[ -z "$(echo "$edges" | tr -d ' ')" ] && ok "rule 1 — outline is only ever the focus ring" \
                                     || bad "rule 1 — outline used as an edge: $edges"

# Rule 2 — RADII ARE STATIC AND ON THE SCALE.
#
#   sm 8 · md 12 · lg 16 · bubble 22 · field 28 · pill 999
#
# Two clauses. First: no bare literal — every radius names a token, or is the
# `0` a reset needs. Second: nothing animates a corner. The rest / hover / focus
# tiers this package used to carry are gone, and a `transition` that names
# border-radius is those tiers growing back somewhere nobody is looking.
offscale=$(cat $SCSS_ALL | grep -nE '^[[:space:]]*border-radius[[:space:]]*:' \
  | grep -vE ':[[:space:]]*(0|var\(--dp-r-[a-z]+\));' | tr '\n' ' ')
[ -z "$(echo "$offscale" | tr -d ' ')" ] && ok "rule 2 — every radius is 0 or a --dp-r-* token" \
                                         || bad "rule 2 — off-scale radius: $offscale"

morph=$(cat $SCSS_ALL | grep -nE 'transition[^;]*border-radius' | tr '\n' ' ')
[ -z "$(echo "$morph" | tr -d ' ')" ] && ok "rule 2 — no corner is animated" \
                                      || bad "rule 2 — a corner is animated: $morph"

# Rule 3 — the accent appears once, and zero times at rest.
#
# The old form of this rule counted `dp-accent-soft` twice in one file: one
# declaration, one use. The split makes the pair a triple — the core declares it
# and uses it, the adapter re-declares it — so what the rule always MEANT is
# asserted instead: it is USED exactly once anywhere, and DECLARED exactly once
# per file.
#
# Per FILE, over `$ADAPTERS`, rather than the two hardcoded names it grew up
# with: an adapter that forgot the accent would otherwise leave the panel's one
# tinted surface painted from the core's literal on a host that re-themes
# everything around it, and no rule would say so.
uses=$(cat $SCSS_ALL | grep -c 'var(--dp-accent-soft' || true)
decls=''
accent_ok=1
for f in $CORE $ADAPTERS; do
  n=$(grep -c '^\s*--dp-accent-soft:' "$f" || true)
  decls="$decls $(basename "$f")=$n"
  [ "$n" -eq 1 ] || accent_ok=0
done
if [ "$uses" -eq 1 ] && [ "$accent_ok" -eq 1 ]; then
  ok "rule 3 — accent declared once per file, used once"
else
  bad "rule 3 — accent used $uses times, declared$decls, expected one use and one declaration per file"
fi
# `-e` is not optional: a pattern beginning with `--` is otherwise read as a
# flag, grep exits 2 with a usage message, and the `if` takes the else branch —
# a rule that prints "ok" while checking nothing.
# The accent may be named ONCE, where the local token is declared from it —
# `--dp-focus: var(--vp-c-brand-1)`. Every other reference goes through the
# local name, so re-theming is one line rather than a search-and-replace. The
# fallback inside `--dp-accent-soft` is that same declaration, so it is exempt
# by living on a `--dp-` line.
brand=$(cat $SCSS_ALL | grep -nE -e '--vp-c-brand-|--brand-soft-bg|--brand-bg-active' \
  | grep -v -e '--dp-' | tr '\n' ' ')
[ -z "$(echo "$brand" | tr -d ' ')" ] && ok "rule 3 — no direct brand token reference" \
                                     || bad "rule 3 — brand token used outside its declaration: $brand"


# Rule 5 — FOUR UI type sizes plus the two relative ones, across both files.
#
#   24px  display — the empty state's greeting, and nothing else
#   16px  body    — the answer, the question, both composers, the mobile nav row
#   14px  UI      — titles, rows, source titles, the FAB label, the article CTA
#   13px  meta    — the status line, pills, counters, footnotes, mono blocks
#
# The relative pair are the only sizes allowed to BE relative: a superscript and
# an inline code chip both have to track the text they sit in.
#
# `[^;]+` rather than `[0-9.]+(px|em)`: the old form could not see a `rem`, a
# `var()` or a `clamp()`, so a type scale smuggled into a token was invisible to
# the one rule that exists to stop exactly that.
sizes=$(cat $SCSS_ALL | grep -oE 'font-size: *[^;]+' | sed 's/font-size: *//' | sort -u | tr '\n' ' ')
allowed=$(printf '%s' "$sizes" | tr ' ' '\n' | grep -vE '^(24px|16px|14px|13px|0.9em|0.75em)$' | tr '\n' ' ')
[ -z "$(echo "$allowed" | tr -d ' ')" ] && ok "rule 5 — sizes: $sizes" \
                                        || bad "rule 5 — unexpected sizes: $allowed"

# Rule 6 — exactly two @keyframes loops, and both on the busy status node: the
# breathing dot and the label sweeping beside it. Both are cancelled by
# prefers-reduced-motion and by forced-colors, which is checked separately
# because a cancelled sweep that keeps its transparent text fill is invisible.
loops=$(cat $SCSS_ALL | grep -c 'infinite' || true)
[ "$loops" -eq 2 ] && ok "rule 6 — two looping animations" \
                   || bad "rule 6 — $loops looping animations, expected 2"

# Both files, so the assertion cannot be sidestepped by moving the guard block.
for guard in 'prefers-reduced-motion' 'forced-colors'; do
  block=$(awk -v g="$guard" '
    /@media/ && index($0, g) { depth = 1; capture = 1; next }
    capture {
      depth += gsub(/\{/, "{"); depth -= gsub(/\}/, "}")
      print
      if (depth <= 0) capture = 0
    }' $SCSS_ALL)
  if printf '%s' "$block" | grep -q 'docpilot__status-label' \
     && printf '%s' "$block" | grep -q 'text-fill-color'; then
    ok "rule 6 — $guard restores an opaque status label"
  else
    bad "rule 6 — $guard does not restore the status label's text fill"
  fi
done

# These two checks read CODE, not prose. Both rules are stated verbatim in the
# files' own comments, so a naive grep flags the documentation of the rule as a
# violation of it — strip comments first.
strip_comments() {
  sed -e 's://.*::' -e 's:/\*.*\*/::' "$@" | grep -vE '^[[:space:]]*(\*|/\*)'
}

# Rule 7 — --vp-c-text-3 never reaches text.
if strip_comments $SCSS_ALL | grep -q 'vp-c-text-3' || strip_comments "$VUE" | grep -q 'vp-c-text-3'; then
  bad "rule 7 — --vp-c-text-3 is referenced in code"
else
  ok "rule 7 — no --vp-c-text-3 reference"
fi

# Rule 8 — the core knows nothing about VitePress. This is the whole point of
# the split: `core.scss` has to render a correct panel with no adapter loaded,
# on a site that is not VitePress at all.
# Symmetric across hosts, because the rule was never about VitePress: the core
# has to render a correct panel with NO adapter loaded, and a Docusaurus token
# smuggled in breaks that exactly as a VitePress one would. Added when the second
# adapter landed — a rule that names only the first host it was written for stops
# being a rule the moment there is a second.
leak=$(strip_comments "$CORE" \
  | grep -nE -e '--vp-' -e '\.VP' -e 'html\.dark' -e '--ifm-' -e '\[data-theme' | tr '\n' ' ')
[ -z "$(echo "$leak" | tr -d ' ')" ] && ok "rule 8 — core.scss names no host token or selector" \
                                    || bad "rule 8 — a host reaches the core: $leak"

# Rule 9 — the adapter is a MAPPING, not a second design.
#
# 9a: every selector it opens belongs to VitePress or to Shiki — never one of
#     ours, because a rule on our own selector here would be invisible to anyone
#     reading core.scss and would not exist for a consumer of core.css alone.
#
#     ONE EXCEPTION, added by ui-specs/009 and deliberately narrow:
#     `html.docpilot-*` as a STATE QUALIFIER. `ui.layout: 'push'` needs the
#     host's own `.VPContent` to move while the panel is open, so the SUBJECT of
#     the rule is foreign — which is exactly what 9a exists to require — and our
#     class only says when. It has to be anchored to `html.` so that a bare
#     `.docpilot__thing` here still fails: the exception is about a root state
#     flag, not about styling our elements from the adapter.
# 9b: the `:root` blocks contain `--dp-*` and nothing else — that is what makes
#     this file a translation table rather than a stylesheet.
#
# Nesting counts: a rule nested inside `.VPNavBar:has(…)` is still a rule about
# the host's navbar, so only the OUTERMOST selector of each chain is checked —
# and `@media` is transparent, because the selectors inside one are outermost.
#
# THE ALLOWLIST IS PER ADAPTER, not shared. Each host owns a different set of
# foreign selectors, and one merged list would admit a `.VP…` rule into a
# Docusaurus adapter — a rule that can never match, in the file whose whole job
# is to be the translation for that host. An adapter with no entry here allows
# NOTHING, so adding a stylesheet to `$ADAPTERS` without naming its host fails
# loudly instead of passing unchecked.
adapter_allow() {
  case "$1" in
    *vitepress.scss) printf '%s' '^(:root|\.VP|html\.dark|html:not|html\.docpilot-|\.shiki)' ;;
    *docusaurus.scss) printf '%s' '^(:root|html\[data-theme|\[data-theme|html:not|html\.docpilot-|\.navbar|\.theme-doc|\.main-wrapper|\.shiki)' ;;
    # Matches nothing: an empty selector head is already treated as transparent
    # before the test is reached, so every head that gets here is non-empty.
    *) printf '%s' '^$' ;;
  esac
}

# The pattern travels in the ENVIRONMENT, not through `awk -v`. `-v` runs escape
# processing over the value, which turns `\.VP` into `.VP` — a regex matching any
# character followed by `VP`, so the rule would keep printing "ok" while checking
# something weaker than what is written above. `ENVIRON` is passed through
# verbatim.
foreign_selectors() {
  strip_comments "$1" | ALLOW="$2" awk '
    BEGIN { depth = 0; ok[0] = 0; allow = ENVIRON["ALLOW"] }
    {
      line = $0
      gsub(/#\{[^}]*\}/, "", line)          # Sass interpolation is not a block
      while (length(line)) {
        o = index(line, "{"); c = index(line, "}")
        if (o == 0 && c == 0) break
        if (o != 0 && (c == 0 || o < c)) {
          head = substr(line, 1, o - 1)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", head)
          depth++
          if (head ~ /^@/ || head == "") ok[depth] = 0          # transparent
          else if (ok[depth - 1]) ok[depth] = 1                 # nested in a checked chain
          else {
            ok[depth] = (head ~ allow)
            if (!ok[depth]) print head
          }
          line = substr(line, o + 1)
        } else {
          if (depth > 0) depth--
          line = substr(line, c + 1)
        }
      }
    }'
}

sel=''
for f in $ADAPTERS; do
  hits=$(foreign_selectors "$f" "$(adapter_allow "$f")" | tr '\n' ' ')
  [ -z "$(echo "$hits" | tr -d ' ')" ] || sel="$sel $(basename "$f"): $hits"
done
[ -z "$(echo "$sel" | tr -d ' ')" ] && ok "rule 9 — adapters style only foreign selectors" \
                                    || bad "rule 9 — an adapter styles a selector of ours:$sel"

rooted=''
for f in $ADAPTERS; do
  hits=$(strip_comments "$f" | awk '
    /^:root[[:space:]]*\{/ { inroot = 1; next }
    inroot && /^\}/ { inroot = 0; next }
    inroot && /[^[:space:]]/ && $0 !~ /^[[:space:]]*--dp-/ { print }' | tr '\n' ' ')
  [ -z "$(echo "$hits" | tr -d ' ')" ] || rooted="$rooted $(basename "$f"): $hits"
done
[ -z "$(echo "$rooted" | tr -d ' ')" ] && ok "rule 9 — :root carries only --dp-* declarations" \
                                       || bad "rule 9 — non-token declaration on :root:$rooted"

# The bundle is an entry point and must stay one: two @use lines and nothing
# else, or a rule would exist in a file no other check reads.
entry=$(strip_comments "$ENTRY" | grep -vE '^[[:space:]]*(@use|$)' | tr '\n' ' ')
[ -z "$(echo "$entry" | tr -d ' ')" ] && ok "rule 9 — docpilot.scss is nothing but @use" \
                                     || bad "rule 9 — the bundle entry carries rules: $entry"

# Rule 10 — THE PUBLISHED TOKEN TABLE AND THE CORE AGREE.
#
# `ui-specs/000-design-system.md` is repo-internal and carries the reasoning;
# `docs/guide/appearance.md` is what a consumer reads and carries the table. A
# token declared and not documented is one nobody can override; a token
# documented and not declared is advice that does nothing. Neither is visible in
# a diff, so it is checked.
#
# ONLY that one page. `docs/.vitepress/theme/styles.css` declares
# `--dp-brand-gradient`, which belongs to the documentation SITE's own theme and
# has nothing to do with the panel — widening this rule, or running a `--dp-`
# replacement across `docs/`, walks straight into it.
#
# TWO pages now, not one. `docs/reference/theme.md` is a second published copy
# of the same table, and it says of itself that "the published table and
# core.scss are asserted to name exactly the same 33 properties" — a sentence
# that was false for as long as this rule read one file. A second copy is a
# second place to drift, and the page that promises it is checked is the worst
# place to leave unchecked.
declared=$(grep -oE '^[[:space:]]*--dp-[a-z0-9-]+' "$CORE" | tr -d ' ' | sort -u)
rule10=0
for DOCS in docs/guide/appearance.md docs/reference/theme.md; do
  if [ ! -s "$DOCS" ]; then
    bad "rule 10 — $DOCS is missing or empty"
    rule10=1
    continue
  fi
  documented=$(grep -oE -- '--dp-[a-z0-9-]+' "$DOCS" | sort -u)
  undoc=$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$documented") | tr '\n' ' ')
  unreal=$(comm -13 <(printf '%s\n' "$declared") <(printf '%s\n' "$documented") | tr '\n' ' ')
  if [ -n "$(echo "$undoc$unreal" | tr -d ' ')" ]; then
    bad "rule 10 — $DOCS — undocumented:$undoc / not declared:$unreal"
    rule10=1
  fi
done
[ "$rule10" -eq 0 ] && ok "rule 10 — both token tables and core.scss agree"

# Scope enforcement — the harness must not be able to reach the index.
if strip_comments "$HARNESS" | grep -qE '\bindex\b'; then
  bad "scope — harness.js references the index; ids must resolve through the retriever"
else
  ok "scope — harness.js holds no index reference"
fi

printf '\n'
[ "$fail" -eq 0 ] && printf '  all checks passed\n\n' || printf '  CHECKS FAILED\n\n'
exit "$fail"
