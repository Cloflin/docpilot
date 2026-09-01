<template>
  <Teleport to="body">
    <div v-if="s.open" class="docpilot">
      <div v-if="mobile" class="docpilot__scrim" @click="close" />

      <!--
        Desktop is NON-MODAL: no scrim, no focus trap, docs stay readable beside
        the answer. Declaring aria-modal there would be a lie. Below 960px there
        is no room to read anything else, so it is honestly modal.
      -->
      <section
        ref="panel"
        class="docpilot__panel"
        :class="`docpilot__panel--${panelKind}`"
        tabindex="-1"
        :role="mobile ? 'dialog' : 'complementary'"
        :aria-modal="mobile ? 'true' : undefined"
        aria-labelledby="dp-title"
        @keydown.esc.stop.prevent="onEsc"
      >
        <header class="docpilot__header" :class="{ 'is-scrolled': scrolled }">
          <!-- the trigger's own glyph: the control pressed and the panel it
               produced carry one mark. aria-hidden, so the heading is still
               named "DocPilot" for aria-labelledby on the mobile dialog. -->
          <h2 id="dp-title" class="docpilot__title"><Icon name="sparkle" />{{ T('panel.title') }}</h2>
          <div class="docpilot__header-actions">
            <!-- past → new → close. Managing conversations is a panel-level
                 action, which is why it sits beside New chat rather than in the
                 footnote row with the scope and prompt toggles. -->
            <button
              v-if="hasHistory"
              id="dp-history-btn"
              type="button"
              class="docpilot__icon-btn"
              :aria-label="T('history.open')"
              :aria-expanded="String(s.dockPanel === 'history')"
              aria-controls="dp-history"
              @click="toggleDock('history')"
            >
              <Icon name="history" />
            </button>
            <!--
              The conversation as Markdown — ui-specs/009,
              `history.exportThread`. Under the same condition as New chat, and
              beside it: both act on the thread as a whole, which is what makes
              them panel-level rather than turn-level controls.

              Four 32px controls plus their gaps against the title at
              `--dp-width: 360px` is tight, and the TITLE is what gives: at that
              width the panel is named by the thread under it.
            -->
            <button
              v-if="s.turns.length && s.config.history.exportThread"
              type="button"
              class="docpilot__icon-btn"
              :aria-label="T('panel.copyThread')"
              @click="copyThread"
            >
              <Icon :name="threadCopied ? 'check' : 'copy'" />
            </button>
            <button
              v-if="s.turns.length"
              type="button"
              class="docpilot__icon-btn"
              :aria-label="T('panel.newChat')"
              @click="newChat"
            >
              <Icon name="compose" />
            </button>
            <button type="button" class="docpilot__icon-btn" :aria-label="T('panel.close')" @click="close">
              <Icon name="x" />
            </button>
          </div>
        </header>

        <!--
          Past conversations, docked under the header — ui-specs/003.

          It opens where its trigger is: the button is top right, beside New chat
          and Close, and a disclosure that appears three hundred pixels away at
          the other end of the panel is a disclosure the reader has to go find.
          It is also a navigation surface — picking a row replaces the whole
          thread — and one that pushed the composer around while being read.

          Its own shell rather than the scope picker's: that one carries a rule
          on its TOP edge, which is correct under a thread and inverted here.
        -->
        <div v-if="s.dockPanel === 'history'" id="dp-history" class="docpilot__dock" tabindex="-1">
          <div class="docpilot__dock-acts">
            <!-- aria-hidden: the list below is already named -->
            <span class="docpilot__picker-label" aria-hidden="true">{{ T('history.label') }}</span>
            <button v-if="s.history.length" type="button" class="docpilot__text-btn" @click="clearAll">
              {{ T(confirmClear ? 'history.clearAllConfirm' : 'history.clearAll') }}
            </button>
            <button
              type="button"
              class="docpilot__icon-btn docpilot__picker-close"
              :aria-label="T('history.close')"
              @click="closeDock()"
            >
              <Icon name="x" />
            </button>
          </div>

          <p v-if="!s.history.length" class="docpilot__meta">{{ T('history.empty') }}</p>

          <!-- A list of things you activate, not a listbox: ARIA forbids an
               interactive descendant inside role="option", and every row here
               carries a delete control. -->
          <ol
            v-else
            class="docpilot__sources docpilot__history-list"
            role="list"
            :aria-label="T('history.list')"
          >
            <li v-for="c in s.history" :key="c.id" class="docpilot__source docpilot__history-row">
              <button
                type="button"
                class="docpilot__history-open"
                :aria-current="c.id === s.conversationId ? 'true' : undefined"
                @click="openConversation(c.id)"
              >
                <span class="docpilot__source-title">{{ c.title }}</span
                ><span class="docpilot__source-tail"> · {{ ago(c.updatedAt) }}</span>
              </button>
              <!-- A bin, not an `×` — ui-specs/006. Everywhere else in this
                   panel `×` dismisses something; this is the one control with
                   no undo behind it, and it had borrowed that mark. -->
              <button
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('history.delete', { title: c.title })"
                @click="removeConversation(c.id)"
              >
                <Icon name="trash" />
              </button>
            </li>
          </ol>
        </div>

        <div
          ref="thread"
          class="docpilot__thread"
          tabindex="0"
          role="region"
          :aria-label="T('panel.conversation')"
          @scroll.passive="onThreadScroll"
        >
          <!-- The docs were rebuilt since this conversation was written. The
               answers still render — every in-answer link is re-checked against
               the current index — but a citation ROW is host-built data and can
               still point at a page that has gone. -->
          <p v-if="s.conversationStale && s.turns.length" class="docpilot__meta">
            {{ T('history.stale') }}
          </p>

          <!-- empty state: a centred greeting, the configured questions anchored
               to the composer. The greeting is resident in every scope; the
               questions are not. -->
          <!-- `!s.busy` as well as `!s.turns.length`: editing the FIRST question
               empties the thread for the width of one flush before the
               replacement turn is pushed, and a greeting that blinks through
               that gap reads as the panel resetting itself. -->
          <div v-if="!s.turns.length && !s.busy" class="docpilot__empty">
            <div class="docpilot__greeting">
              <p class="docpilot__greeting-h">{{ T('empty.heading') }}</p>
              <p class="docpilot__greeting-p">{{ T('empty.body') }}</p>
            </div>
            <div v-if="suggestions.length" class="docpilot__suggestions">
              <button
                v-for="q in suggestions"
                :key="q"
                type="button"
                class="docpilot__suggestion"
                @click="submitText(q)"
              >
                {{ q }}
              </button>
            </div>

            <!--
              Under a narrow scope, the pages in it — ui-specs/009.

              The three built-in openers are suppressed there, correctly: they
              would fall outside the scope and the gate would refuse all of them
              on contact. The result was a blank panel shown to the one reader
              who had expressed their intent more precisely than usual.

              ROWS, not generated questions. The source-row recipe, because it is
              the same object — a page with a title and a tail that opens when
              pressed — and because nothing here is invented.
            -->
            <template v-if="scopedPages.length">
              <p class="docpilot__meta">{{ T('empty.scopedLead') }}</p>
              <ol class="docpilot__sources" role="list" :aria-label="T('empty.scopedLead')">
                <li v-for="(p, i) in scopedPages" :key="p.path" class="docpilot__source">
                  <span class="docpilot__source-n">{{ i + 1 }}</span>
                  <a :href="p.path" @click="onSourceClick($event, { href: p.path })">
                    <span class="docpilot__source-title">{{ p.title }}</span
                    ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
                  </a>
                </li>
              </ol>
            </template>

            <!--
              The one thing a reader will not discover — ui-specs/009,
              `ui.firstRunHint`, off by default. Withheld when neither quoting
              switch is on, because a hint naming a gesture the panel does not
              answer is worse than no hint.
            -->
            <p v-if="showHint" class="docpilot__row docpilot__hint">
              <span class="docpilot__meta">{{ T('empty.hint') }}</span>
              <button type="button" class="docpilot__text-btn" @click="dismissHint">
                {{ T('empty.hintDismiss') }}
              </button>
            </p>
          </div>

          <article v-for="turn in s.turns" :key="turn.id" class="docpilot__turn">
            <!-- The passage this question was about — ui-specs/007. Above the
                 bubble and quieter than it: the reference is not the ask. -->
            <p v-if="turn.quote" class="docpilot__quote">
              <Icon name="quote" /><span class="docpilot__quote-text"
                ><span class="docpilot__sr">{{ T('quote.label') }} </span>{{ turn.quote }}</span
              >
            </p>
            <!-- The bubble, or the field it stands for. The rest of the turn —
                 the answer, its sources, its actions — stays on screen while
                 the editor is open: nothing has been withdrawn until it is
                 sent. -->
            <template v-if="editingId === turn.id">
              <div class="docpilot__edit">
                <label class="docpilot__sr" :for="`dp-edit-field-${turn.id}`">
                  {{ T('actions.editLabel') }}
                </label>
                <textarea
                  :id="`dp-edit-field-${turn.id}`"
                  v-model="editDraft"
                  class="docpilot__edit-field"
                  rows="1"
                  maxlength="1000"
                  @input="grow"
                  @keydown="onEditKeydown"
                ></textarea>
              </div>
              <div class="docpilot__edit-acts">
                <button type="button" class="docpilot__text-btn" @click="cancelTurnEdit">
                  {{ T('actions.editCancel') }}
                </button>
                <button
                  type="button"
                  class="docpilot__text-btn"
                  :aria-disabled="String(!canSaveEdit)"
                  @click="saveTurnEdit(turn)"
                >
                  {{ T('actions.editSave') }}
                </button>
              </div>
            </template>
            <template v-else>
              <p class="docpilot__question">{{ turn.question }}</p>
              <!-- The same hover-revealed row as the answer's below, at the
                   edge the bubble sits on. Copy works while a turn is running;
                   editing does not, because `submit` refuses on `busy` and the
                   thread would be truncated for nothing. -->
              <div class="docpilot__actions docpilot__actions--ask">
                <button
                  type="button"
                  class="docpilot__icon-btn"
                  :aria-label="T('actions.copyQuestion')"
                  @click="copyQuestion(turn)"
                >
                  <Icon :name="turn.questionCopied ? 'check' : 'copy'" />
                </button>
                <button
                  :id="`dp-edit-${turn.id}`"
                  type="button"
                  class="docpilot__icon-btn"
                  :aria-label="T('actions.edit')"
                  :aria-disabled="String(s.busy)"
                  @click="startTurnEdit(turn)"
                >
                  <Icon name="pencil" />
                </button>
              </div>
            </template>

            <!-- one live node of fixed geometry whose text is replaced in place -->
            <div
              v-if="s.busy && turn === s.turns[s.turns.length - 1]"
              class="docpilot__status"
              aria-hidden="true"
            >
              <span class="docpilot__status-dot" />
              <span class="docpilot__status-label">{{ statusLabel }}</span>
            </div>

            <!-- reasoning: above the answer, open while it is the only thing happening -->
            <template v-if="turn.thought">
              <button
                type="button"
                class="docpilot__thoughts-toggle"
                :aria-expanded="String(!!turn.thoughtOpen)"
                :aria-controls="`dp-thoughts-${turn.id}`"
                @click="toggleThought(turn)"
              >
                {{ thoughtLabel(turn) }}
              </button>
              <div
                v-if="turn.thoughtOpen"
                :id="`dp-thoughts-${turn.id}`"
                class="docpilot__thoughts"
                role="region"
                :aria-label="T('panel.reasoning')"
                @scroll.passive="onThoughtScroll(turn, $event)"
              >{{ turn.thought }}</div>
            </template>

            <div
              v-if="turn.answerHtml"
              class="docpilot__answer"
              :data-turn="turn.id"
              tabindex="-1"
              role="region"
              :aria-label="T('panel.answer')"
              :aria-busy="s.busy && turn === s.turns[s.turns.length - 1] ? 'true' : 'false'"
              v-html="turn.answerHtml"
              @click="onAnswerClick"
              @pointerover="onCiteEnter"
              @pointerout="linkedCite = null"
              @focusin="onCiteEnter"
              @focusout="linkedCite = null"
            />

            <p v-if="turn.state === 'aborted'" class="docpilot__meta">{{ T('turn.stopped') }}</p>

            <!-- Kept rather than withdrawn: cited, so checkable, but the model
                 was not sure. The sources below are the point. -->
            <p v-if="turn.tentative && turn.state === 'complete'" class="docpilot__meta">
              {{ T('turn.tentative') }}
            </p>

            <!-- refusal: one state, four causes -->
            <template v-if="turn.state === 'no-answer'">
              <p v-if="settledLine(turn)" class="docpilot__meta">{{ settledLine(turn) }}</p>
              <p class="docpilot__lead">{{ leadLine(turn) }}</p>
              <p v-if="turn.credential" class="docpilot__meta">{{ turn.credential.copy.body }}</p>
              <!-- social: what this is, what it covers, and a question back. The
                   suggestion rows repeat here because an invitation with nothing
                   to act on is the refusal it was written to replace. -->
              <template v-if="turn.social">
                <p v-if="turn.social.copy.body" class="docpilot__meta">{{ turn.social.copy.body }}</p>
                <p v-if="turn.social.copy.invite" class="docpilot__meta">
                  {{ turn.social.copy.invite }}
                </p>
                <div
                  v-if="turn.social.copy.invite && suggestions.length"
                  class="docpilot__suggestions docpilot__suggestions--inline"
                >
                  <button
                    v-for="q in suggestions"
                    :key="q"
                    type="button"
                    class="docpilot__suggestion"
                    @click="submitText(q)"
                  >
                    {{ q }}
                  </button>
                </div>
              </template>
              <!--
                What "read N pages" was reading — ui-specs/009,
                `citations.pagesRead`, off by default.

                Under the verdict rather than under the provenance line it
                belongs to, because the verdict is the message and evidence for
                it reads after it, not before. Same position, same treatment and
                the same list idiom as the closest pages directly below.
              -->
              <template v-if="turn.refusal.pages?.length">
                <p class="docpilot__meta">{{ T('refusal.pagesReadLabel') }}</p>
                <ol class="docpilot__sources" role="list" :aria-label="T('refusal.pagesReadLabel')">
                  <li v-for="(p, i) in turn.refusal.pages" :key="p.path" class="docpilot__source">
                    <span class="docpilot__source-n">{{ i + 1 }}</span>
                    <a :href="p.path" @click="onSourceClick($event, { href: p.path })">
                      <span class="docpilot__source-title">{{ p.title }}</span>
                    </a>
                  </li>
                </ol>
              </template>
              <p v-if="turn.refusal.closest.length" class="docpilot__meta">
                {{ T(turn.refusal.closestAreOutside ? 'refusal.closestPagesElsewhere' : 'refusal.closestPages') }}
              </p>
              <ol
                v-if="turn.refusal.closest.length"
                class="docpilot__sources"
                role="list"
                :aria-label="T('panel.closestPages')"
              >
                <li v-for="(c, i) in turn.refusal.closest" :key="c.path" class="docpilot__source">
                  <span class="docpilot__source-n">{{ i + 1 }}</span>
                  <a
                    :href="c.origin || c.path"
                    :target="c.origin ? '_blank' : null"
                    :rel="c.origin ? 'noopener noreferrer' : null"
                    @click="onSourceClick($event, { origin: c.origin, href: c.path })"
                  >
                    <span class="docpilot__source-title">{{ c.title }}</span
                    ><span v-if="c.tail" class="docpilot__source-tail"> · {{ c.tail }}</span>
                  </a>
                </li>
              </ol>
              <button
                v-if="turn.refusal.cause === 'out-of-scope'"
                type="button"
                class="docpilot__text-btn"
                @click="widen(turn)"
              >
                {{ T('refusal.widen') }}
              </button>
              <!-- The question was fine; the value in it was not. This runs the
                   same question with the value already replaced by YOUR_SECRET_KEY. -->
              <button
                v-if="turn.credential"
                type="button"
                class="docpilot__text-btn"
                @click="askWithoutSecret(turn)"
              >
                {{ turn.credential.copy.action }}
              </button>
            </template>

            <!--
              SEARCH-ONLY — the passages, as the answer.

              The rows render whether or not the gate passed; `noStrongMatches`
              chooses the lead and nothing else. Every row is a verbatim passage
              under a link into the docs, so there is no generated claim here for
              the panel to be wrong about, and hiding matches that exist in order
              to say "not in the docs" would be the less honest of the two.
            -->
            <template v-if="turn.state === 'results'">
              <p v-if="settledLine(turn)" class="docpilot__meta">{{ settledLine(turn) }}</p>
              <!--
                `turn.hybrid` is the last rung of the answer ladder: every
                service the environment selected was asked, none answered, and
                the retrieval this turn had already done is what is left. It
                names the cause once and then reads exactly like the search-only
                product, because that is what it is.
              -->
              <p class="docpilot__lead">
                {{
                  turn.hybrid
                    ? turn.results.length
                      ? T('hybrid.lead')
                      : T('error.lead')
                    : turn.results.length
                      ? T(turn.noStrongMatches ? 'results.noStrong' : 'results.lead', {
                          scope: turnScope(turn),
                        })
                      : T('results.empty', { scope: turnScope(turn) })
                }}
              </p>
              <ol
                v-if="turn.results.length"
                class="docpilot__sources docpilot__results"
                role="list"
                :aria-label="T('results.label')"
                @keydown="onResultsKey($event, turn)"
              >
                <li v-for="(r, i) in turn.results" :key="r.id" class="docpilot__source">
                  <span class="docpilot__source-n">{{ i + 1 }}</span>
                  <div class="docpilot__result-body">
                    <!-- `href` is already the original for an imported page —
                         `resultRows` builds it from `page.origin` — so there is
                         no second address to choose between here. -->
                    <a
                      :href="r.href"
                      :target="r.origin ? '_blank' : null"
                      :rel="r.origin ? 'noopener noreferrer' : null"
                      :tabindex="i === resultFocus(turn) ? 0 : -1"
                      :data-dp-result="i"
                      @click="onSourceClick($event, { origin: r.origin, href: r.href })"
                    >
                      <span class="docpilot__source-title">{{ r.title }}</span
                      ><span v-if="r.breadcrumb" class="docpilot__source-tail">
                        · {{ r.breadcrumb }}</span
                      >
                    </a>
                    <!-- Escaped in `markQuery` before any markup is added: the
                         snippet is corpus text and the marks are ours. -->
                    <p
                      v-if="r.snippet"
                      class="docpilot__result-snippet"
                      v-html="markQuery(r.snippet, turn.question)"
                    ></p>
                  </div>
                </li>
              </ol>
              <!-- No rows at all: pages instead of sections, the same floor a
                   refusal falls to. -->
              <template v-if="!turn.results.length && turn.closest.length">
                <p class="docpilot__meta">
                  {{ T(turn.closestAreOutside ? 'refusal.closestPagesElsewhere' : 'refusal.closestPages') }}
                </p>
                <ol class="docpilot__sources" role="list" :aria-label="T('panel.closestPages')">
                  <li v-for="(c, i) in turn.closest" :key="c.path" class="docpilot__source">
                    <span class="docpilot__source-n">{{ i + 1 }}</span>
                    <a
                      :href="c.origin || c.path"
                      :target="c.origin ? '_blank' : null"
                      :rel="c.origin ? 'noopener noreferrer' : null"
                      @click="onSourceClick($event, { origin: c.origin, href: c.path })"
                    >
                      <span class="docpilot__source-title">{{ c.title }}</span
                      ><span v-if="c.tail" class="docpilot__source-tail"> · {{ c.tail }}</span>
                    </a>
                  </li>
                </ol>
              </template>
              <button
                v-if="turn.wouldWiden"
                type="button"
                class="docpilot__text-btn"
                @click="widen(turn)"
              >
                {{ T('refusal.widen') }}
              </button>
              <!--
                Retry belongs on this one and on no other `results` turn: a
                search-only site has nothing to retry, and here the outage may
                well have cleared. The same pair the transport error offers, for
                the same reasons — the quote travels with the question, and
                search stays offered because it never depended on a model.
              -->
              <p v-if="turn.hybrid" class="docpilot__row">
                <button
                  type="button"
                  class="docpilot__text-btn"
                  @click="submitText(turn.question, turn.quote)"
                >
                  {{ T('error.retry') }}
                </button>
                <button v-if="hasSearch" type="button" class="docpilot__text-btn" @click="openSearch">
                  {{ T('error.search') }}
                </button>
              </p>
            </template>

            <template v-if="turn.state === 'error'">
              <p class="docpilot__lead" role="alert">{{ T('error.lead') }}</p>
              <p class="docpilot__row">
                <!-- with its quote: a retry that drops the passage re-runs a
                     question whose whole subject has gone missing -->
                <button
                  type="button"
                  class="docpilot__text-btn"
                  @click="submitText(turn.question, turn.quote)"
                >
                  {{ T('error.retry') }}
                </button>
                <button
                  v-if="hasSearch"
                  type="button"
                  class="docpilot__text-btn"
                  @click="openSearch"
                >
                  {{ T('error.search') }}
                </button>
              </p>
            </template>

            <!--
              The day's free requests are spent. A separate state from `error`
              and separate copy, because the service DID answer and what it
              answered was a schedule.

              No `role="alert"` here, unlike the transport failure above: this
              state settles a turn, and session.js announces every settled turn
              through the polite live region already — an assertive region on top
              of that reads the same sentence twice.

              No Retry either. The next request is already known to be refused,
              and offering to spend it is the one affordance that would make
              things worse. Search still works, so it stays offered.
            -->
            <template v-if="turn.state === 'rate-limited'">
              <p class="docpilot__lead">{{ T('error.rateLimited') }}</p>
              <p v-if="resetLine(turn)" class="docpilot__meta">{{ resetLine(turn) }}</p>
              <!--
                The passages, under a spent quota. They cost nothing — retrieval
                settled before the first request went out — and a panel that
                prints "come back at four" while the sections that answer the
                question sit in memory is being less useful than the index it
                shipped with. Links only, no snippets: this is an addition to an
                explanation, not the answer, and the state above keeps its own
                sentence.
              -->
              <template v-if="turn.results?.length">
                <p class="docpilot__meta">{{ T('hybrid.meanwhile') }}</p>
                <ol class="docpilot__sources" role="list" :aria-label="T('results.label')">
                  <li v-for="(r, i) in turn.results" :key="r.id" class="docpilot__source">
                    <span class="docpilot__source-n">{{ i + 1 }}</span>
                    <a
                      :href="r.href"
                      :target="r.origin ? '_blank' : null"
                      :rel="r.origin ? 'noopener noreferrer' : null"
                      @click="onSourceClick($event, { origin: r.origin, href: r.href })"
                    >
                      <span class="docpilot__source-title">{{ r.title }}</span
                      ><span v-if="r.breadcrumb" class="docpilot__source-tail">
                        · {{ r.breadcrumb }}</span
                      >
                    </a>
                  </li>
                </ol>
              </template>
              <p v-if="hasSearch" class="docpilot__row">
                <button type="button" class="docpilot__text-btn" @click="openSearch">
                  {{ T('error.search') }}
                </button>
              </p>
            </template>

            <!--
              `role="list"` on an ordered list is redundant markup everywhere
              except here. `.docpilot__sources` sets `list-style: none`, and
              Safari drops list semantics from a list styled that way outside a
              `nav` — which takes the item count with it and leaves the
              `aria-label` below naming an element that no longer has a role to
              be named. All three lists in this panel carry it for that reason.
            -->
            <ol
              v-if="turn.sources.length"
              class="docpilot__sources"
              role="list"
              :aria-label="T('panel.sources')"
            >
              <li
                v-for="src in turn.sources"
                :key="src.id"
                class="docpilot__source"
                :class="{ 'is-linked': linkedCite === src.n, 'has-passage': passage(turn, src) }"
              >
                <span class="docpilot__source-n">{{ src.n }}</span>
                <a
                  :href="src.origin || src.href"
                  :target="src.origin ? '_blank' : null"
                  :rel="src.origin ? 'noopener noreferrer' : null"
                  @click="onSourceClick($event, src)"
                >
                  <span class="docpilot__source-title">{{ src.title }}</span
                  ><span v-if="src.tail" class="docpilot__source-tail"> · {{ src.tail }}</span>
                </a>
                <!--
                  The passage this citation was drawn from — ui-specs/009.

                  Absent, not disabled, when there is nothing to show: a restored
                  conversation whose chunk the rebuilt index no longer has. A
                  control that opens onto nothing is worse than no control.

                  A disclosure on the ROW rather than a preview on the marker.
                  ChatGPT Search previews on hover and its own help page says
                  that does not exist on mobile — where checking a source means
                  clicking through. A disclosure is one control for pointer,
                  touch and keyboard alike.
                -->
                <button
                  v-if="passage(turn, src)"
                  type="button"
                  class="docpilot__icon-btn"
                  :aria-expanded="String(openPassage === src.id)"
                  :aria-controls="`dp-passage-${turn.id}-${src.n}`"
                  :aria-label="T(openPassage === src.id ? 'citation.hidePassage' : 'citation.showPassage')"
                  @click="togglePassage(src.id)"
                >
                  <Icon name="chevronDown" :class="openPassage === src.id ? 'is-open' : null" />
                </button>
                <!--
                  Rendered markdown, not the chunk's source. It is corpus text
                  either way; the only question is whether the reader parses the
                  `##` and the `**` or the panel does — and the answer above it
                  never asks them to.

                  `onAnswerClick` for the same reason the answer carries it: a
                  link inside v-html has no Vue handler of its own, and a chunk's
                  own cross-references are exactly the links a reader following
                  provenance will press.
                -->
                <div
                  v-if="openPassage === src.id"
                  :id="`dp-passage-${turn.id}-${src.n}`"
                  class="docpilot__passage"
                  tabindex="0"
                  role="region"
                  :aria-label="T('citation.passageLabel')"
                  v-html="passageHtml(turn, src)"
                  @click="onAnswerClick"
                ></div>
              </li>
            </ol>

            <div
              v-if="turn.state === 'complete' || turn.state === 'no-answer' || turn.state === 'aborted'"
              class="docpilot__actions"
              :class="{ 'is-resident': feedbackLive }"
            >
              <button
                v-if="turn.state !== 'no-answer'"
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('actions.copy')"
                @click="copy(turn)"
              >
                <Icon :name="turn.copied ? 'check' : 'copy'" />
              </button>
              <!-- Ask the same question again, in place of this answer rather
                   than below it. On a refusal it is the FIRST control in the
                   row, because copy is absent there and "I couldn't find this"
                   is the one verdict a reader most wants to test. -->
              <button
                v-if="canRetry(turn)"
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('actions.retry')"
                :aria-disabled="String(s.busy)"
                @click="retryTurn(turn)"
              >
                <Icon name="retry" />
              </button>
              <button
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('actions.helpful')"
                :aria-pressed="String(turn.verdict === 'up')"
                @click="vote(turn, 'up')"
              >
                <Icon name="thumbUp" :filled="turn.verdict === 'up'" />
              </button>
              <button
                :id="`dp-down-${turn.id}`"
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('actions.notHelpful')"
                :aria-pressed="String(turn.verdict === 'down')"
                @click="vote(turn, 'down')"
              >
                <Icon name="thumbDown" :filled="turn.verdict === 'down'" />
              </button>
              <!-- The thumb is a toggle, so pressing it again withdraws the vote
                   rather than reopening the form. Without this control a reader
                   who closed the form has no way back that does not also take
                   back what they already said. -->
              <button
                v-if="turn.verdict === 'down' && !turn.reasonOpen"
                type="button"
                class="docpilot__text-btn"
                @click="turn.reasonOpen = true"
              >
                {{ T('actions.tellUsMore') }}
              </button>
            </div>

            <!--
              Where to go next — ui-specs/009, `suggestions.followUps`, OFF.

              Under the NEWEST turn only. Three rows after every answer turns a
              thread into a feed, and the measurement behind the default is not a
              taste: ChatGPT ships these and its readers write custom
              instructions to suppress them.

              The rows are headings from the pages this turn cited, minus the
              headings it already used. Nothing is generated — the template does
              the grammar — so nothing can name a section the corpus does not
              have, which is the failure a generated opener has and this cannot.
            -->
            <div
              v-if="followUps(turn).length"
              class="docpilot__suggestions docpilot__suggestions--inline"
              role="group"
              :aria-label="T('empty.followUpsLabel')"
            >
              <button
                v-for="f in followUps(turn)"
                :key="f"
                type="button"
                class="docpilot__suggestion"
                @click="submitText(f)"
              >
                {{ f }}
              </button>
            </div>

            <form v-if="turn.reasonOpen" class="docpilot__feedback" @submit.prevent="submitFeedback(turn)">
              <!-- aria-pressed toggles rather than checkboxes: a custom checkbox
                   indicator wants a resting border, and rule 1 names every one
                   of those in the stylesheet individually. The pressed pill
                   carries the state instead — ui-specs/004 — and the thumbs
                   directly above are the same pattern. -->
              <div class="docpilot__reasons" role="group" :aria-label="T('actions.reasonsGroup')">
                <button
                  v-for="value in REASONS"
                  :key="value"
                  type="button"
                  class="docpilot__text-btn"
                  :aria-pressed="String(turn.reasons.includes(value))"
                  @click="toggleReason(turn, value)"
                >
                  {{ T(`reasons.${value}`) }}
                </button>
              </div>

              <template v-if="commentable">
                <label class="docpilot__sr" :for="`dp-comment-${turn.id}`">{{ T('feedback.commentLabel') }}</label>
                <textarea
                  :id="`dp-comment-${turn.id}`"
                  v-model="turn.comment"
                  class="docpilot__comment"
                  rows="3"
                  :maxlength="COMMENT_MAX"
                  :placeholder="T('feedback.commentPlaceholder')"
                  :aria-describedby="`dp-hint-${turn.id}`"
                ></textarea>
                <p :id="`dp-hint-${turn.id}`" class="docpilot__meta">{{ T('feedback.commentHint') }}</p>
                <!-- Only near the ceiling: a counter that is always on turns a
                     comment box into a test. -->
                <p v-if="turn.comment.length >= COMMENT_MAX - 50" class="docpilot__meta">
                  {{ T('feedback.counter', { n: turn.comment.length }) }}
                </p>
              </template>

              <div class="docpilot__reasons">
                <button type="submit" class="docpilot__text-btn">{{ T('feedback.submit') }}</button>
                <button type="button" class="docpilot__text-btn" @click="skipFeedback(turn)">
                  {{ T('feedback.skip') }}
                </button>
              </div>
            </form>

            <!--
              What the form leaves behind — ui-specs/009, `feedback.confirm`.

              Submitting used to remove the form and say nothing a sighted reader
              could see, which is indistinguishable from closing it unsent.
              Resident rather than timed out: it is the record of what the reader
              did, and a transcript they scroll back through should still show it.

              Two strings, because one would be false under two of the four
              `send` modes — `feedbackLive` is the same predicate that decides
              whether the action row stays visible at rest.
            -->
            <p v-if="turn.feedbackDone && !turn.reasonOpen" class="docpilot__meta">
              {{ T(feedbackLive ? 'feedback.thanksSent' : 'feedback.thanks') }}
            </p>
          </article>
        </div>

        <!--
          Back to the newest answer, on a rail of zero height between the thread
          and everything under it.

          The `v-if` is on the RAIL and a class does the showing, because a
          `v-if` on the button itself would give the reveal no fade — and a
          `<Transition>` for one control would be a mechanism this package does
          not otherwise have. The opacity/pointer-events pair is the code card's
          copy chip, one floor down.

          Hidden from the tab order rather than merely faded, which is where it
          differs from that chip: at the foot of the thread "go to the foot of
          the thread" is not an action. Withdrawn entirely while a dock is open —
          the picker and the prompt grow out of the composer and the pill would
          be pointing into the part they cover.
        -->
        <div v-if="s.turns.length && !s.dockPanel" class="docpilot__jump-rail">
          <button
            type="button"
            class="docpilot__jump"
            :class="{ 'is-visible': !atBottom }"
            :tabindex="atBottom ? -1 : 0"
            :aria-hidden="atBottom ? 'true' : undefined"
            :aria-label="T('panel.jumpToLatest')"
            @click="jumpToLatest"
          >
            <Icon name="chevronDown" />
          </button>
        </div>

        <!--
          The selection popover — ui-specs/007.

          BETWEEN the thread and the composer, and that is the tab order it
          exists for: a reader who selected inside the thread presses Tab once to
          reach "Ask AI" and once more to reach the field. It is also still
          inside the panel, so the Esc handler on the section above still fires
          when focus is on the button.

          Top layer where the platform has one, so the popup shape's
          `overflow: hidden` cannot clip it; a plain fixed box where it does not,
          which is not clipped either. `manual`, never `auto`: an auto popover
          light-dismisses on the pointerdown that BEGINS the next selection, and
          Esc belongs to the cascade rather than to the platform.
        -->
        <div
          v-if="askOpen"
          ref="askEl"
          class="docpilot__ask"
          :class="{ 'is-below': askBelow }"
          :popover="canPopover ? 'manual' : null"
          :style="askStyle"
        >
          <button type="button" class="docpilot__text-btn docpilot__ask-btn" @click="takeQuote">
            <Icon name="quote" />{{ T('quote.ask') }}
          </button>
        </div>

        <div class="docpilot__composer">
          <!-- at most one disclosure open; all three absent from the DOM at
               rest. Two of the three are here, and both are opened from the
               footnote row directly below: a disclosure opens where its trigger
               is. The third — past conversations — is opened from the HEADER,
               so it is docked up there. ui-specs/003. -->
          <div v-if="s.dockPanel === 'picker'" id="dp-picker" class="docpilot__picker" tabindex="-1">
            <div class="docpilot__picker-acts">
              <!-- aria-hidden: the group below is already named "Set the scope" -->
              <span class="docpilot__picker-label" aria-hidden="true">{{ T('picker.label') }}</span>
              <!-- the group wraps the presets only: closing the picker is not
                   setting a scope, so the close button stays outside it -->
              <div class="docpilot__picker-presets" role="group" :aria-label="T('picker.setScope')">
                <button type="button" class="docpilot__text-btn" @click="preset('all')">{{ T('picker.all') }}</button>
                <button
                  v-if="currentPathIndexed"
                  type="button"
                  class="docpilot__text-btn"
                  @click="preset('page')"
                >
                  {{ T('picker.page') }}
                </button>
                <button
                  v-if="offersSection"
                  type="button"
                  class="docpilot__text-btn"
                  @click="preset('section')"
                >
                  {{ T('picker.section') }}
                </button>
              </div>
              <!-- same exit the Esc cascade takes, and the same focus return -->
              <button
                type="button"
                class="docpilot__icon-btn docpilot__picker-close"
                :aria-label="T('picker.close')"
                @click="closeDock()"
              >
                <Icon name="x" />
              </button>
            </div>
            <!--
              A listbox is ONE tab stop — ui-specs/009.

              Every row used to carry `tabindex="0"`, which on a three-hundred
              page corpus put three hundred stops between this list and the
              composer. Roving tabindex instead: exactly one row is in the tab
              order at a time and the arrow keys move it, which is what the
              pattern has always expected and what a reader arrives expecting.
            -->
            <!--
              The filter — ui-specs/009. OUTSIDE the listbox, because a text
              input is not an option, and bound to it with `aria-controls`.
              `'auto'` shows it once the corpus is past the point where scanning
              a list works, which is the number `promptListLimit` already picked.
            -->
            <template v-if="showFilter">
              <label class="docpilot__sr" for="dp-pick-filter">{{ T('picker.filterLabel') }}</label>
              <input
                id="dp-pick-filter"
                v-model="pickFilter"
                type="search"
                class="docpilot__picker-filter"
                :placeholder="T('picker.filterPlaceholder')"
                aria-controls="dp-picker-list"
                @keydown.down.prevent="focusPickAt(0)"
              />
            </template>
            <div
              id="dp-picker-list"
              class="docpilot__picker-list"
              role="listbox"
              aria-multiselectable="true"
              :aria-label="T('picker.list')"
            >
              <!--
                Grouped by section, and FLAT while a filter is on: grouping a
                filtered list fragments it into headings with one row under each,
                which is the opposite of what narrowing was for.

                `g.offset + j` is the flat index, and it has to match DOM order —
                `focusPickAt` reaches a row by position among the rendered
                `.docpilot__pick` nodes, so the groups' concatenation IS the
                keyboard's list. `pickFlat` is derived from these groups for
                exactly that reason rather than computed alongside them.
              -->
              <template v-for="(g, gi) in pickGroups" :key="g.label || gi">
                <div v-if="g.label" role="group" :aria-label="g.label">
                  <!-- aria-hidden: the group is already named by the label above -->
                  <p class="docpilot__pick-group" aria-hidden="true">{{ g.label }}</p>
                  <div
                    v-for="(p, j) in g.pages"
                    :key="p.path"
                    class="docpilot__pick"
                    role="option"
                    :aria-selected="String(selected.has(p.path))"
                    :tabindex="p.path === rovingPath ? 0 : -1"
                    @click="pickClicked(g.offset + j)"
                    @keydown="onPickKeydown($event, g.offset + j)"
                  >
                    <span class="docpilot__pick-mark">
                      <Icon v-if="selected.has(p.path)" name="check" />
                    </span>
                    <span>
                      <span class="docpilot__source-title">{{ p.title }}</span
                      ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
                    </span>
                  </div>
                </div>
                <!-- The ungrouped case: no wrapper, so the rows sit directly
                     in the listbox where `role="option"` expects to be. -->
                <template v-else>
                  <div
                    v-for="(p, j) in g.pages"
                    :key="p.path"
                    class="docpilot__pick"
                    role="option"
                    :aria-selected="String(selected.has(p.path))"
                    :tabindex="p.path === rovingPath ? 0 : -1"
                    @click="pickClicked(g.offset + j)"
                    @keydown="onPickKeydown($event, g.offset + j)"
                  >
                    <span class="docpilot__pick-mark">
                      <Icon v-if="selected.has(p.path)" name="check" />
                    </span>
                    <span>
                      <span class="docpilot__source-title">{{ p.title }}</span
                      ><span v-if="p.tail" class="docpilot__source-tail"> · {{ p.tail }}</span>
                    </span>
                  </div>
                </template>
              </template>
            </div>
          </div>

          <div v-if="s.dockPanel === 'prompt'" id="dp-prompt" class="docpilot__prompt" tabindex="0"
               role="region" :aria-label="T('promptDoc.region')">
            <template v-for="block in promptBlocks" :key="block.heading">
              <p class="docpilot__prompt-h">{{ block.heading }}</p>
              <textarea
                v-if="block.yours && editing"
                v-model="draft"
                class="docpilot__prompt-edit"
                rows="3"
                :maxlength="s.config.prompt.appendMaxChars"
              />
              <p v-else :class="block.yours ? 'docpilot__prompt-yours' : null">{{ block.body }}</p>
            </template>
            <p v-if="s.config.prompt.allowAppend" class="docpilot__row">
              <template v-if="editing">
                <button type="button" class="docpilot__text-btn" @click="saveEdit">{{ T('promptDoc.save') }}</button>
                <button type="button" class="docpilot__text-btn" @click="editing = false">{{ T('promptDoc.cancel') }}</button>
              </template>
              <template v-else>
                <button type="button" class="docpilot__text-btn" :aria-disabled="String(s.busy)" @click="startEdit">
                  {{ T(s.instruction ? 'promptDoc.edit' : 'promptDoc.add') }}
                </button>
                <button
                  v-if="s.instruction"
                  type="button"
                  class="docpilot__text-btn"
                  :aria-disabled="String(s.busy)"
                  @click="removeInstruction"
                >
                  {{ T('promptDoc.remove') }}
                </button>
              </template>
            </p>
          </div>

          <template v-if="s.degraded">
            <p class="docpilot__lead">{{ T('degraded.lead') }}</p>
            <p class="docpilot__row" v-if="hasSearch">
              <button type="button" class="docpilot__text-btn" @click="openSearch">{{ T('degraded.search') }}</button>
            </p>
          </template>

          <template v-else>
            <!-- The quote as a draft: it is the reader's, so they can take it
                 back. `maxlength` on the field below is untouched by it — the
                 passage is not part of what they typed. -->
            <div v-if="quote" class="docpilot__quote docpilot__quote--draft">
              <Icon name="quote" /><span id="dp-quote" class="docpilot__quote-text"
                ><span class="docpilot__sr">{{ T('quote.label') }} </span>{{ quote }}</span
              >
              <button
                type="button"
                class="docpilot__icon-btn"
                :aria-label="T('quote.drop')"
                @click="dropQuote"
              >
                <Icon name="x" />
              </button>
            </div>

            <div class="docpilot__field">
              <textarea
                v-model="input"
                rows="1"
                maxlength="1000"
                :placeholder="placeholder"
                :readonly="s.busy"
                aria-describedby="dp-quote dp-hint dp-counter dp-budget dp-footnote"
                @input="grow"
                @keydown="onKeydown"
              />
              <button
                type="button"
                class="docpilot__send"
                :class="{ 'is-ready': canSend || s.busy }"
                :aria-disabled="String(!canSend && !s.busy)"
                :aria-label="T(s.busy ? 'composer.stop' : 'composer.send')"
                @click="send"
              >
                <Icon :name="s.busy ? 'square' : 'arrowUp'" :filled="s.busy" />
              </button>
            </div>

            <p v-if="input.length >= 950" id="dp-counter" class="docpilot__counter">
              {{ T('composer.counter', { n: input.length }) }}
            </p>

            <!-- What the next question is limited to — what is left of the day's
                 free answers, and whether this site retrieves without an
                 embedder — in the place the reader is deciding whether to spend
                 one. Described BY the field for the same reason the counter is:
                 it changes what a question costs and what it can find, and a
                 reader who cannot see it is the one most likely to be surprised
                 when the answers stop. -->
            <p v-if="statusLine" id="dp-budget" class="docpilot__budget">
              {{ statusLine }}<span v-if="showBudgetLow"> · {{ T('error.budgetLow') }}</span>
            </p>

            <p id="dp-footnote" class="docpilot__footnote">
              <button
                v-if="s.config.scope.enabled"
                id="dp-scope-btn"
                type="button"
                class="docpilot__scope"
                :aria-expanded="String(s.dockPanel === 'picker')"
                aria-controls="dp-picker"
                :aria-label="T('composer.scopeAria', { scope: scopeLabel })"
                @click="toggleDock('picker')"
              >{{ scopeLabel }}</button
              ><span v-if="s.turns.length"
                ><template v-if="s.config.scope.enabled"> · </template>{{ disclaimer }}</span
              ><span v-if="s.config.ui.credit"
                ><template v-if="creditSep"> · </template
                ><a
                  class="docpilot__credit"
                  :href="CREDIT_URL"
                  :title="T('credit.title')"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ T('credit.label') }}</a
                ></span
              >
              <button
                v-if="s.config.prompt.show && (s.turns.length || s.instruction)"
                type="button"
                class="docpilot__prompt-toggle"
                :aria-expanded="String(s.dockPanel === 'prompt')"
                aria-controls="dp-prompt"
                @click="toggleDock('prompt')"
              >{{ promptToggleText }}</button>
            </p>
          </template>
        </div>

        <span id="dp-hint" class="docpilot__sr">{{ T('composer.hint', { scope: scopeLabel }) }}</span>
      </section>
    </div>
    <!--
      OUTSIDE the `v-if`, and that is the whole point of it being down here.

      It used to live in the composer, which meant it was destroyed with the
      panel — so a turn that settled while the panel was shut announced into
      nothing, and ui-specs/010 made that the normal case rather than an edge
      one. It also means the region is now RESIDENT: a live region inserted in
      the same frame as its text is a region some screen readers do not
      announce, which is a race this used to run on every open.

      This component is mounted on every page; only its subtree is conditional.
    -->
    <div class="docpilot__sr" aria-live="polite">{{ announced }}</div>
  </Teleport>
</template>

<script setup lang="ts">
import {
  computed,
  h,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  type FunctionalComponent,
} from 'vue'
import * as session from '../docpilot/session.js'
import type { Turn } from '../docpilot/session.js'
import { useHost, hostConfig } from '../docpilot/host.js'
import { promptDocument, clampQuote } from '../docpilot/prompt.js'
import { sectionFor } from '../docpilot/scope.js'
import { GLYPH_BOX, GLYPH_DEFAULTS, symbolId } from '../docpilot/glyphs.js'
import { resolveI18n, t as translate, normaliseLocale } from '../docpilot/i18n.js'
import { relativeParts } from '../docpilot/history.js'
import { COMMENT_MAX } from '../docpilot/feedback.js'
import { createSelectionAsk } from '../docpilot/selection.js'
import { FILTER_AUTO_ABOVE, DEFAULT_SUGGESTIONS, SUGGESTION_LIMIT } from '../docpilot/switches.js'
import { hasDailyAllowance } from '../docpilot/budget.js'
import { terms } from '../docpilot/text.js'
import { atBottom as isAtBottom, createFollower } from '../docpilot/follow.js'
import { bindUnload, unbindUnload } from '../docpilot/unload.js'
import { waitingKey } from '../docpilot/status.js'
import { redactSecrets } from '../docpilot/credentials.js'

const s = session.state
const { theme, route, lang, router } = useHost()

/**
 * Every reader-facing string in this component goes through `T`.
 *
 * The tree is the configured DELTA — the shipped defaults live inside i18n.js
 * and are looked up behind it, so a project that overrides nothing ships no
 * extra bytes. The selector is the PAGE's locale: this is chrome. The two
 * strings that follow the reader's typed language instead — the credential and
 * social replies — are settled in session.js and arrive already rendered.
 */
const i18nTree = computed(() => resolveI18n(s.config.i18n))
const uiLocale = computed(() => normaliseLocale(lang.value, i18nTree.value))
const T = (path, vars) => translate(i18nTree.value, uiLocale.value, path, vars)

const panel = ref<HTMLElement | null>(null)
const thread = ref<HTMLElement | null>(null)
const mobile = ref(false)
// Not the same question as `mobile`. A narrow window is about how much room
// there is; this is about what the platform draws over a selection — see
// `place()`, which flips the popover below one on a touchscreen.
const coarse = ref(false)

/**
 * Has the thread moved off its top? — ui-specs/002.
 *
 * The header's divider is absent at rest and appears the moment there is
 * something above the fold, so the title reads as a layer over the conversation
 * rather than as a permanent second boundary competing with the panel's edge.
 *
 * CSS scroll-state queries (`@container scroll-state(scrollable: top)`) are the
 * native form of this and are Chromium-only today, so this is the fallback that
 * guide itself documents: one class, from one predicate. The listener is
 * passive — it never calls `preventDefault`, and a non-passive scroll handler on
 * the panel's one scroller is a jank source for no gain.
 */
const scrolled = ref(false)

/**
 * Is the reader at the foot of the thread? — the predicate behind the jump pill.
 *
 * A SECOND signal, next to `threadFollow.pinned`, and the two are kept apart
 * because they are read at different MOMENTS rather than from different facts.
 * This one is "where is the reader now", written on every scroll and on every
 * path that swaps the conversation, and it drives a control. The pin is "was
 * the reader at the foot the last time the box moved", and it is consulted
 * inside the frame that writes — where a streaming answer has already grown the
 * scroller and this one is briefly, correctly, false. Folding them together
 * would flash the pill in for the one frame between "taller" and "scrolled to
 * the new bottom", which is the flash the write order below already avoids.
 */
const atBottom = ref(true)
// One per scroller that gets written to. See follow.js: the pin is read from
// the scroll event, and both of these are handed their element per call because
// the reasoning box is unmounted every time a reader collapses one.
const threadFollow = createFollower()
const thoughtFollow = createFollower()
const syncAtBottom = () => {
  const el = thread.value
  // The same slack the follower pins on, so the pill cannot appear while the
  // autoscroll still considers itself pinned.
  if (el) atBottom.value = isAtBottom(el)
}

const onThreadScroll = (e: Event) => {
  scrolled.value = e.target.scrollTop > 0
  // Whatever moved the thread — a wheel, a finger, a scrollbar, PageUp, a
  // screen reader — this is where the follower hears about it. An autoscroll
  // write lands at the foot, so its own event can only re-pin: follow.js.
  threadFollow.read(e.target)
  syncAtBottom()
  // The selection popover is placed against the viewport, so a scrolling thread
  // moves the passage out from under it. `reposition` is a no-op when it is
  // closed, which is nearly always.
  reposition()
}

/**
 * Which of the two shapes this panel is — resolved once, in the store, and read
 * here as a finished value. Never `'auto'`: `resolveUi` settles that at build
 * time and again in `configure()`, so the template's only job is to name it.
 */
const panelKind = computed(() => s.config.ui.panel)
const input = ref('')
const draft = ref('')
const editing = ref(false)
const announced = ref('')
let trigger: HTMLElement | null = null
let mql: MediaQueryList | null = null
let coarseMql: MediaQueryList | null = null
// The selection watcher's five listeners, released as one — see `ask.bind`.
let unbindAsk: (() => void) | null = null

const scopeLabel = session.scopeLabel
const offersSection = session.offersSection
const currentPathIndexed = session.currentPathIndexed

// Declared once, at module-body level, because it is both ADDED and REMOVED.
// It used to be an arrow inside `onMounted` while the removal named a hoisted
// function of the same name — two different references, so the listener was
// added on every mount and removed on none of them.
function sync() {
  mobile.value = !mql?.matches
}
function syncPointer() {
  coarse.value = !!coarseMql?.matches
}

onMounted(() => {
  mql = window.matchMedia('(min-width: 960px)')
  sync()
  mql.addEventListener('change', sync)
  coarseMql = window.matchMedia('(pointer: coarse)')
  syncPointer()
  coarseMql.addEventListener('change', syncPointer)

  // What the page keeps when it goes away — ui-specs/012. Bound here rather than
  // in `open()` because a turn outlives the panel (ui-specs/010): the thing that
  // has to survive leaving is the TURN, and it runs whether the panel is on
  // screen or not. The component is resident — the polite region lives outside
  // the `v-if` for the same reason — so this listener's life is the panel's life
  // on the page.
  bindUnload(onLeaving)

  // Read on mount, not in the ref's initialiser: `localStorage` does not exist
  // during SSR, and the default is `true` so a server render and the first
  // client frame agree on showing nothing.
  try {
    hintSeen.value = localStorage.getItem(HINT_KEY) === '1'
  } catch {
    hintSeen.value = true
  }

  // Same reason, and the watcher is armed HERE rather than at setup so it can
  // never fire before that read has decided whether this tab has already been
  // told. A throw costs the notice a repeat after a reload, which is the
  // cheaper of the two failures.
  let toldBudgetLow = false
  try {
    toldBudgetLow = sessionStorage.getItem(BUDGET_LOW_KEY) === '1'
  } catch {
    /* private mode — the notice may come back once, and that is all */
  }
  if (!toldBudgetLow) {
    watch(
      budgetLowDue,
      (due) => {
        if (!due || budgetLowSaid.value) return
        budgetLowSaid.value = true
        // SAID as well as shown, and this is the half that was missing. The note
        // renders inside the composer's `aria-describedby`, and no screen reader
        // re-reads a description that changed under a textarea the reader is
        // already focused in — so the one reader who cannot see answers getting
        // shorter was the one reader never told they would. It goes through the
        // store's live region, the same one session.js announces every settled
        // turn through, so it queues behind "answer ready" instead of talking
        // over it. Once per session, on the same flag the visible note is
        // retired by: a mode change is news exactly once.
        s.announce = T('error.budgetLow')
        try {
          sessionStorage.setItem(BUDGET_LOW_KEY, '1')
        } catch {
          /* see above */
        }
      },
      { immediate: true },
    )
  }

  // The selection watcher — five listeners, bound and unbound as one, in
  // `selection.js`. `pointerdown` runs in the CAPTURE phase there, so a press
  // on a control that stops propagation still dismisses the popover.
  unbindAsk = ask.bind(onSelectionAccepted)

  session.configure(theme.value, route.value, lang.value)

  // The composer's own text, before the deep link that may replace it.
  restoreDraft()

  // `?dp-ask=` — ui-specs/009. After `configure`, because the switch that
  // governs it arrives with the config; the question lands in `pendingQuestion`
  // and is drained by the watcher below, which is also where a passage quoted
  // in the host's article arrives.
  session.applyDeepLink(location.search, (params) => {
    const q = params.toString()
    history.replaceState(history.state, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`)
  })
})

/**
 * A question handed in from outside the panel — ui-specs/009.
 *
 * The store carries it rather than the component reading the URL itself,
 * because two surfaces put a question there: the deep link above, and the
 * article's own selection popover. Draining it here keeps `input` the single
 * owner of what is in the field.
 *
 * NOT SUBMITTED, in either case. The reader reads what somebody else wrote
 * before it is asked on their behalf.
 */
watch(
  () => s.pendingQuestion,
  (q) => {
    if (!q) return
    input.value = q
    s.pendingQuestion = ''
    nextTick(() => {
      const ta = panel.value?.querySelector('.docpilot__field textarea')
      if (!ta) return
      fit(ta)
      // The caret at the end, so the reader can add to it without pressing End
      // first — `startTurnEdit`'s rule, and for the same reason.
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  },
)

// The passage half of the same handoff: a selection taken in the host's article
// arrives as a draft chip, exactly as one taken inside an answer does.
watch(
  () => s.pendingQuote,
  (text) => {
    if (!text) return
    quote.value = text
    s.pendingQuote = ''
  },
)

// The page's locale, kept in the store as well as here: session.js writes the
// screen-reader announcements and settles the credential and social replies, and
// none of that runs inside a component where `useHost()` is reachable.
watch(lang, (l) => session.setLang(l))

onBeforeUnmount(() => {
  mql?.removeEventListener('change', sync)
  coarseMql?.removeEventListener('change', syncPointer)
  unbindUnload()
  unbindAsk?.()
  unbindAsk = null
  // The announce queue outlives one drain, so its timer has to be cancelled
  // here as well: a pending callback would write into a ref whose component
  // has gone.
  clearTimeout(draftTimer)
  clearTimeout(announceTimer)
  announceQueue.length = 0
  clearTimeout(typeTimer)
})

watch(route, (r) => (s.currentPath = r))

/**
 * The polite region is a QUEUE, not a slot — ui-specs/009.
 *
 * It is still throttled, and for the reason it always was: pushing every token
 * through a live region is one uninterruptible blast that cannot be paused,
 * rewound or navigated, and `modern-web-guidance` adds the second half — a small
 * delay keeps an announcement from landing on top of the speech that focus
 * management has just produced.
 *
 * What changed is what happened to a message that arrived DURING the wait. It
 * was dropped: `clearTimeout` and then overwrite, so of "Quote added" followed
 * inside half a second by "Answer ready", only the second was ever spoken. The
 * reader who depends on this region is the only one who could have noticed.
 */
const ANNOUNCE_MS = 500
const announceQueue = []
let announceTimer: ReturnType<typeof setTimeout> | null = null

function drainAnnounce() {
  const next = announceQueue.shift()
  // A polite region speaks when its text CHANGES, so the same message twice in
  // a row would be silent the second time. A zero-width space makes it a
  // different string and reads identically.
  announced.value = next === announced.value ? `${next}​` : next
  announceTimer = announceQueue.length ? setTimeout(drainAnnounce, ANNOUNCE_MS) : null
}

watch(
  () => s.announce,
  (msg) => {
    if (!msg) return
    announceQueue.push(msg)
    if (!announceTimer) announceTimer = setTimeout(drainAnnounce, ANNOUNCE_MS)
  },
)

/**
 * `push` — the host's content moves aside instead of being covered.
 * ui-specs/009, `ui.layout`, and `overlay` stays the default.
 *
 * A CLASS ON THE ROOT, because the rule that acts on it names VitePress's own
 * selectors and therefore belongs in the adapter — where rule 2 allows exactly
 * that and nothing else. The component decides WHEN; the adapter decides what it
 * means on this host, and a consumer with a different theme overrides one rule
 * rather than patching a component.
 *
 * Not below the sheet breakpoint: there the panel is edge to edge and there is
 * no room to push anything into.
 */
const LAYOUT_CLASS = 'docpilot-push'

watch(
  () => [s.open, s.config.ui.layout, mobile.value],
  ([open, layout, narrow]) => {
    if (typeof document === 'undefined') return
    const on = open && layout === 'push' && !narrow
    document.documentElement.classList.toggle(LAYOUT_CLASS, on)
  },
)

// The class outlives the component otherwise: a route change that unmounts the
// panel with the drawer open would leave the host's content permanently inset.
onBeforeUnmount(() => document.documentElement.classList.remove(LAYOUT_CLASS))

watch(
  () => s.open,
  async (open) => {
    if (open) {
      trigger = document.activeElement
      await nextTick()
      setTimeout(() => {
        // Below 960px focus the container, never the textarea: a tabindex="-1"
        // container does not raise the software keyboard over the whole sheet.
        if (mobile.value) panel.value?.focus()
        // The composer, by its own class — a bare `textarea` is whichever one
        // comes first in the DOM, and an open feedback comment or question
        // editor sits above the composer in the thread.
        else panel.value?.querySelector('.docpilot__field textarea')?.focus()
      }, 60)
    } else {
      // The popover's node unmounts with the panel, which implicitly closes it —
      // but `askOpen` would stay true and the next open would call showPopover()
      // against a stale rect.
      closeAsk()
      quote.value = ''
      // Wait for the panel to leave the DOM first. The floating button is
      // hidden by a `:has()` rule while a panel is open, and `focus()` on a
      // `display: none` element is a silent no-op — so without this the focus
      // would be dropped on the floor exactly in the mode where the button the
      // reader pressed is the only thing to return to.
      await nextTick()
      if (trigger && document.contains(trigger)) trigger.focus()
      else visibleTrigger()?.focus?.()
      trigger = null
    }
  },
)

/**
 * Where focus lands when the element that opened the panel is gone — a route
 * change while it was open, or a `v-if` that unmounted the mobile nav screen.
 *
 * HARDENING, NOT A FIX, and worth saying so plainly: no configuration is known
 * where this changes the outcome today. It was written when `trigger` became a
 * list, on the reasoning that `document.querySelector('.docpilot-nav-trigger')`
 * returns whichever placement is FIRST IN THE DOCUMENT — the navbar button
 * whenever there is one — and `focus()` on a `display: none` element is a silent
 * no-op. Measured across 320–1400px on VitePress 1.6.4 and 2.0.0-alpha.19, the
 * navbar button is displayed at every width, so the premise does not currently
 * bite; the placements are configurable and the hide rules are CSS, so "the
 * first one is the one you can see" is an assumption this had no reason to keep.
 *
 * `getClientRects()` is the test, not `offsetParent`: a `position: fixed`
 * element — which the FAB is — reports a null `offsetParent` in every browser
 * even when it is plainly on screen.
 *
 * The host's own content is the last resort and was already: somewhere in the
 * document beats nowhere, which is what a dropped focus means for a keyboard.
 */
function visibleTrigger() {
  const buttons = document.querySelectorAll('.docpilot-nav-trigger')
  for (const el of buttons) if (el.getClientRects().length) return el
  return document.querySelector(hostConfig(s.config).content)
}

// Autoscroll: one coalesced rAF per frame, and it stops the moment the reader
// moves the thread themselves — `onThreadScroll` above is where that is heard.
let queued = false
watch(
  () => s.turns.map((t) => t.answerHtml + (t.thought || '').length + t.state).join('|'),
  () => {
    // A token per frame is common and a token per millisecond is not unheard
    // of; without this the frame is requested once per token and writes the
    // same number to the same property N times before the browser paints once.
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      // The pin is tested HERE, inside the frame, and not at the top of this
      // watcher: a reader who scrolls up in the gap between the token and the
      // frame it asked for would otherwise be dragged back down by a frame that
      // was queued while they were still at the foot. `follow` makes the test.
      threadFollow.follow(thread.value)
      // After the write, not before: a streaming answer grows the scroller on
      // every frame, and the pill would otherwise flash in for the one frame
      // between "taller" and "scrolled to the new bottom".
      syncAtBottom()
    })
  },
)

const close = () => session.close()
// `scrolled` is written by a scroll EVENT, and replacing the thread's contents
// does not reliably produce one — a shorter document clamps `scrollTop` without
// always notifying. So every path that swaps the conversation says so directly,
// or the header keeps a divider describing a scroll position that no longer
// exists. `atBottom` is the same value read from the same scroller, so it is
// reset in the same three places and for the same reason.
const newChat = () => {
  session.newChat()
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}
const vote = session.vote
const toggleReason = session.toggleReason
// A press outranks the stream for the rest of the turn — session.js/autoThought.
const toggleThought = session.toggleThought
const widen = session.widen
const askWithoutSecret = session.askWithoutSecret

// The form unmounts on submit, and focus would land on <body> — a keyboard
// reader would be returned to the top of the document, three screens from where
// they were. Back to the thumb that opened it, which is `closeDock`'s own rule.
function refocusThumb(turn) {
  nextTick(() => panel.value?.querySelector(`#dp-down-${turn.id}`)?.focus())
}
const submitFeedback = (turn) => {
  session.submitFeedback(turn)
  refocusThumb(turn)
}
const skipFeedback = (turn) => {
  session.skipFeedback(turn)
  refocusThumb(turn)
}

function onEsc() {
  // FIRST. The popover is the most recently opened thing on screen and the one
  // the reader is looking at; anything below this would close a disclosure they
  // are not thinking about, or the panel itself. It does NOT clear the chip:
  // that is content the reader chose, like a typed draft, and the same rule the
  // feedback comment keeps applies. The `×` is its removal.
  if (askOpen.value) return closeAsk()
  const active = document.activeElement
  const has = (sel) => panel.value?.querySelector(sel)?.contains(active)
  // `.docpilot__dock` is named here as well as the picker and the prompt: the
  // conversation list stopped wearing the picker's class when it moved to the
  // top of the panel, and without this Esc inside it would fall past the
  // disclosure and close the whole panel.
  if (s.dockPanel && (has('.docpilot__picker') || has('.docpilot__prompt') || has('.docpilot__dock')))
    return closeDock()
  // The question editor, when the caret is in it. The draft IS discarded here,
  // where the feedback comment's is kept — and the difference is that the
  // original question is still one line above, unharmed, while a comment exists
  // nowhere else once it is gone.
  if (editingId.value && has('.docpilot__edit')) return cancelTurnEdit()
  const reasonTurn = s.turns.find((t) => t.reasonOpen)
  // The FORM, not the reasons row inside it. Focus is usually in the textarea,
  // which is the row's SIBLING — testing the row let Esc fall through to
  // `close()` and take the whole panel with it, discarding what was typed.
  // Escape closes the form and keeps the draft: the reader can reopen it.
  if (reasonTurn && has('.docpilot__feedback')) return skipFeedback(reasonTurn)
  if (s.dockPanel) return closeDock()
  if (reasonTurn) return skipFeedback(reasonTurn)
  // Focus left the editor without closing it — clicked into the composer, say.
  // Esc still belongs to the open thing before it belongs to the panel.
  if (editingId.value) return cancelTurnEdit()
  if (s.busy) return session.stop()
  close()
}

const OPENERS = {
  picker: '#dp-scope-btn',
  prompt: '.docpilot__prompt-toggle',
  history: '#dp-history-btn',
}

function closeDock() {
  const opener = OPENERS[s.dockPanel] || OPENERS.prompt
  s.dockPanel = null
  editing.value = false
  confirmClear.value = false
  // The picker's tab stop and its filter both go back with it. A reopened
  // picker is a fresh decision, and returning the reader to a row — or to a
  // narrowing — from three conversations ago is a memory nobody asked this
  // control to keep.
  activePick.value = null
  pickFilter.value = ''
  nextTick(() => panel.value?.querySelector(opener)?.focus())
}

// Focused by id, not by class: the conversation list also carries the picker's
// class, so a class selector would focus the wrong node the day both exist.
function toggleDock(which) {
  s.dockPanel = s.dockPanel === which ? null : which
  confirmClear.value = false
  // What stands in for a `storage` event: another tab may have added or removed
  // a conversation since this list was last drawn.
  if (s.dockPanel === 'history') session.refreshHistory()
  if (s.dockPanel) nextTick(() => panel.value?.querySelector(`#dp-${which}`)?.focus())
}

// ── conversations ────────────────────────────────────────────────────────────
const hasHistory = computed(
  () => s.config.history.enabled && (s.history.length > 0 || s.turns.length > 0),
)

const openConversation = (id) => {
  session.openConversation(id)
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}
const removeConversation = session.removeConversation

// Two steps, the same idiom the copy button uses: a native confirm() would be
// the only blocking browser dialog in the package, and this is the reader's
// only undo for a store that outlives the tab.
const confirmClear = ref(false)
function clearAll() {
  if (!confirmClear.value) {
    confirmClear.value = true
    return
  }
  confirmClear.value = false
  session.clearHistory()
  input.value = ''
  quote.value = ''
  closeAsk()
  scrolled.value = false
  atBottom.value = true
}

/**
 * "3 hours ago", in the page's locale.
 *
 * `Intl.RelativeTimeFormat` rather than a table entry: the panel's own
 * pluraliser is two-form by design and cannot express Russian or Polish, and
 * `numeric: 'auto'` gives "yesterday" for free. The arithmetic is in history.js,
 * where it is testable; only the formatting needs a locale.
 */
const ago = (then) => {
  const { value, unit } = relativeParts(then, Date.now())
  try {
    return new Intl.RelativeTimeFormat(uiLocale.value, { numeric: 'auto' }).format(value, unit)
  } catch {
    return new Date(then).toLocaleDateString(uiLocale.value)
  }
}

// ── scope ────────────────────────────────────────────────────────────────────
const pages = computed(() => s.index?.manifest.pages || [])
const selected = computed(() => new Set(s.scope.paths))

const orderedPages = computed(() => {
  const here = s.currentPath
  const section = s.index ? sectionFor(here, s.index.manifest) : null
  const inSection = new Set(section?.paths || [])
  const orphans = new Set(s.index?.manifest.orphanPages || [])
  const rank = (p) =>
    p.path === here ? 0 : inSection.has(p.path) ? 1 : orphans.has(p.path) ? 3 : 2
  return [...pages.value].sort((a, b) => rank(a) - rank(b))
})

const togglePage = (path) => {
  const next = new Set(s.scope.paths)
  next.has(path) ? next.delete(path) : next.add(path)
  session.setScope([...next])
}

/**
 * ── the picker at corpus scale — ui-specs/009 ───────────────────────────────
 *
 * A flat, unfiltered list of every page in a `min(240px, 32dvh)` scroller is
 * fine at twelve pages and unusable at three hundred.
 */
const pickFilter = ref('')

const showFilter = computed(() => {
  const mode = s.config.scope.filter
  if (typeof mode === 'boolean') return mode
  return pages.value.length > FILTER_AUTO_ABOVE
})

/** Title first, then route: a reader filtering by `/guide/` means the route. */
const pickPages = computed(() => {
  const q = pickFilter.value.trim().toLowerCase()
  if (!q) return orderedPages.value
  return orderedPages.value.filter(
    (p) => (p.title || '').toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  )
})

/**
 * The rendered structure, and the keyboard's list, in one object.
 *
 * `offset` is the flat index of a group's first row, so `offset + j` is the
 * position among the rendered `.docpilot__pick` nodes — which is how
 * `focusPickAt` reaches one. Deriving `pickFlat` FROM these groups rather than
 * computing it alongside them is what keeps those two definitions from drifting
 * the day the grouping changes the order.
 *
 * Flat while a filter is on: grouping a filtered list fragments it into headings
 * with one row under each, which is the opposite of what narrowing was for.
 */
const pickGroups = computed(() => {
  const list = pickPages.value
  if (!s.config.scope.groupBySection || pickFilter.value.trim() || !s.index) {
    return [{ label: '', offset: 0, pages: list }]
  }
  const manifest = s.index.manifest
  const labelOf = new Map()
  for (const section of manifest.sections || []) {
    for (const i of section.pageIdx) {
      const page = manifest.pages[i]
      // First section wins, so a page in a nested section is named by the
      // outermost one it appears in — the order `manifest.sections` is built in.
      if (page && !labelOf.has(page.path)) labelOf.set(page.path, section.label)
    }
  }
  const groups = []
  const byLabel = new Map()
  for (const page of list) {
    const label = labelOf.get(page.path) || ''
    let group = byLabel.get(label)
    if (!group) {
      group = { label, offset: 0, pages: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.pages.push(page)
  }
  let offset = 0
  for (const group of groups) {
    group.offset = offset
    offset += group.pages.length
  }
  return groups
})

const pickFlat = computed(() => pickGroups.value.flatMap((g) => g.pages))

/**
 * ── the picker's keyboard — ui-specs/009 ────────────────────────────────────
 *
 * Roving tabindex, not `aria-activedescendant`. Both are legal for a listbox and
 * this one picks the variant where **focus is really on the option**, because
 * every other row-shaped control in this package is styled from `:focus-visible`
 * and the alternative would need a second, parallel "looks focused" rule that
 * only this list uses.
 *
 * `activePick` is a PATH rather than an index, because the list it indexes into
 * is re-sorted by `orderedPages` and, once the filter lands, re-filtered as well;
 * an index would silently come to mean a different row.
 */
const activePick = ref<any>(null)

/**
 * The one row in the tab order.
 *
 * Falls to the first row whenever `activePick` names nothing in the current
 * list — nothing visited yet, or a filter that has just removed it. Never null
 * while there are rows, which is the invariant that matters: a listbox with no
 * tab stop is a listbox the keyboard cannot enter at all.
 */
const rovingPath = computed(() => {
  const pages = pickFlat.value
  if (!pages.length) return null
  return pages.some((p) => p.path === activePick.value) ? activePick.value : pages[0].path
})

function focusPickAt(i) {
  const page = pickFlat.value[i]
  if (!page) return
  activePick.value = page.path
  // By position in the rendered list, not by a selector built from the path: a
  // route contains `/` and would have to be escaped, and `CSS.escape` is one
  // more thing to be missing in an engine somewhere.
  nextTick(() => panel.value?.querySelectorAll('.docpilot__pick')?.[i]?.focus())
}

// A press moves the tab stop as well as toggling, so tabbing out and back in
// returns to the row the reader was last working on rather than to the top.
function pickClicked(i) {
  const page = pickFlat.value[i]
  if (!page) return
  activePick.value = page.path
  togglePage(page.path)
}

/**
 * Type-ahead, which a listbox is expected to offer whether or not a filter field
 * also exists — they answer different questions. The filter narrows the list and
 * is a decision; this jumps to a row and is a reflex.
 */
let typeBuf = ''
let typeTimer: ReturnType<typeof setTimeout> | null = null

function onPickKeydown(e: KeyboardEvent, i: number) {
  const pages = pickFlat.value
  const last = pages.length - 1
  switch (e.key) {
    // Clamped rather than wrapping. APG leaves the choice open, and a list this
    // long is one a reader arrows through to get somewhere — arriving back at
    // the top by surprise is the failure mode, not running out of list.
    case 'ArrowDown':
      e.preventDefault()
      return focusPickAt(Math.min(last, i + 1))
    case 'ArrowUp':
      e.preventDefault()
      return focusPickAt(Math.max(0, i - 1))
    case 'Home':
      e.preventDefault()
      return focusPickAt(0)
    case 'End':
      e.preventDefault()
      return focusPickAt(last)
    case 'Enter':
    case ' ':
      // `preventDefault` on Space is not optional: without it the key scrolls
      // the picker's own scroller out from under the row it just toggled.
      e.preventDefault()
      return pickClicked(i)
  }

  if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return
  clearTimeout(typeTimer)
  typeBuf += e.key.toLowerCase()
  typeTimer = setTimeout(() => (typeBuf = ''), 700)
  const hit = pages.findIndex((p) => (p.title || '').toLowerCase().startsWith(typeBuf))
  if (hit >= 0) {
    e.preventDefault()
    focusPickAt(hit)
  }
}

function preset(kind) {
  if (kind === 'all') return session.setScope([])
  if (kind === 'page') return session.setScope([s.currentPath])
  const section = sectionFor(s.currentPath, s.index.manifest)
  if (section) session.setScope(section.paths)
}

// ── prompt ───────────────────────────────────────────────────────────────────
const promptBlocks = computed(() =>
  promptDocument({
    scope: s.scope,
    fallback: s.fallback,
    addendum: s.instruction,
    promptListLimit: s.config.scope.promptListLimit,
    prompt: s.config.prompt,
    product: s.config.product,
    // The DECLARED mode only. A runtime degradation also sends the block on its
    // own turns, but the disclosure describes the deployment, not the last
    // turn's weather — and a panel whose published instructions flickered with
    // an embedder's uptime would be less honest, not more.
    lexicalOnly: s.config.embed.lexicalOnly,
    // Headings only. The bodies are the exact text sent to the model, and a
    // translated body would make this disclosure a description of something
    // other than what was sent.
    labels: {
      headingInstructions: T('promptDoc.headingInstructions'),
      headingToolsNative: T('promptDoc.headingToolsNative'),
      headingToolsText: T('promptDoc.headingToolsText'),
      headingScope: T('promptDoc.headingScope'),
      headingYours: T('promptDoc.headingYours'),
      scopeAllPages: T('promptDoc.scopeAllPages'),
      yoursNone: T('promptDoc.yoursNone'),
    },
  }),
)
const promptToggleText = computed(() =>
  T(s.instruction ? 'promptDoc.toggleWithYours' : 'promptDoc.toggle'),
)
function startEdit() {
  draft.value = s.instruction
  editing.value = true
  nextTick(() => panel.value?.querySelector('.docpilot__prompt-edit')?.focus())
}
function saveEdit() {
  session.setInstruction(draft.value)
  editing.value = false
}
function removeInstruction() {
  session.setInstruction('')
  editing.value = false
}

/**
 * Back to the newest answer.
 *
 * The pin as well as the scroll write: pressing this says "chase it again",
 * and without that a reader who jumps down mid-answer would watch the stream
 * run off the bottom of the box they just came back to.
 *
 * Instantly, not smoothly. `.docpilot__thread` sets `scroll-behavior: auto`
 * because smooth fights the autoscroll write and never settles.
 */
function jumpToLatest() {
  const el = thread.value
  if (!el) return
  threadFollow.repin()
  el.scrollTop = el.scrollHeight
  atBottom.value = true
  // The button is about to disappear from under the pointer, so focus goes to
  // the region it scrolled — which already has a tabindex and an accessible
  // name. A mouse press leaves no ring: `:focus-visible` does not match one.
  el.focus({ preventScroll: true })
}

// ── composer ─────────────────────────────────────────────────────────────────
const canSend = computed(() => input.value.trim().length > 0)
// The measurement itself, separate from the handler: the inline question editor
// opens with text already in it and has to size itself once before any input
// event exists to carry it.
const fit = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
const grow = (e: Event) => fit(e.target as HTMLTextAreaElement)
function send() {
  if (s.busy) return session.stop()
  if (!canSend.value) return
  submitText(input.value, quote.value)
  input.value = ''
  quote.value = ''
  nextTick(() => {
    // The composer specifically. `textarea` alone is the first one in the panel,
    // which is an open question editor or feedback comment whenever one exists —
    // so the wrong field collapsed and the emptied composer stayed tall.
    const ta = panel.value?.querySelector('.docpilot__field textarea')
    if (ta) ta.style.height = 'auto'
  })
}
/**
 * The default second argument is load-bearing. Three call sites pass one
 * argument — the suggestion rows and the retry beside them — and a suggestion is
 * a FRESH question: it must not silently pick up a passage the reader attached
 * and then abandoned. Only the two sites that mean it name a quote.
 */
function submitText(q, quoted = '') {
  threadFollow.repin()
  closeAsk()
  session.submit(q, { quote: quoted })
}
/**
 * Enter sends, Shift+Enter breaks the line — and neither of those is true while
 * an IME is open. ui-specs/012.
 *
 * In Japanese, Chinese and Korean, Enter is ALSO how a candidate is committed,
 * several times per sentence. Without the first line every one of those commits
 * sent a half-typed question and spent a request against a daily allowance the
 * whole site shares. That is a defect rather than a preference, so it has no
 * switch: nobody configures a keyboard to eat their own sentence.
 *
 * BOTH reads are needed. `isComposing` is a property of the native event, and
 * whether Vue's wrapper forwards it is not something this component should have
 * to know — an undefined on one path and the real flag on the other cost
 * nothing to check together.
 *
 * The guard is FIRST, before the branch as well as before the send, because a
 * reader mid-composition is not asking to edit their previous question either.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.nativeEvent?.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
    return
  }
  if (e.key === 'ArrowUp') editLastQuestion(e)
}

/**
 * `↑` in an EMPTY composer opens the last question's editor — ui-specs/009.
 *
 * ChatGPT's own behaviour, and readline's before it, so this is a port rather
 * than an invention: a reader arrives already expecting the key to do this.
 *
 * **The empty condition is not a nicety.** Without it the key stops moving the
 * caret inside a multi-line draft, which is the behaviour it is borrowing from —
 * and a shortcut that eats a navigation key is worse than an absent one.
 *
 * Withheld while a turn is running, because `startTurnEdit` refuses on `busy`
 * anyway and a control that visibly does nothing is the thing 008 argued
 * against; and while an editor is already open, because "at most one editor"
 * is the invariant `editingId` exists to make structural.
 */
function editLastQuestion(e) {
  if (!s.config.composer.editLastOnArrowUp) return
  if (input.value.length || s.busy || editingId.value) return
  const last = s.turns[s.turns.length - 1]
  if (!last) return
  e.preventDefault()
  startTurnEdit(last)
}

/**
 * ── quoting a passage — ui-specs/007, extracted by 009 ──────────────────────
 *
 * Select inside a settled answer and one button appears above the selection.
 * Pressing it attaches the passage to the composer as a chip, where it stays
 * until it is sent or withdrawn.
 *
 * The MECHANISM now lives in `selection.js`, because 009 points a second
 * instance of it at the host's own article and two copies of a list of platform
 * failures is two places for one of them to come back. What stays here is what
 * is specific to the panel: which element a selection has to be inside, whether
 * that turn has settled, which box the button is clamped to, and what counts as
 * furniture in the text.
 */
const quote = ref('')
const askEl = ref<HTMLTextAreaElement | null>(null)

/**
 * The answer node BOTH ends of the selection are inside, or null.
 *
 * `closest` from the common ancestor already proves containment of both ends: a
 * selection that starts in an answer and ends in the source list below it has
 * the TURN as its common ancestor, and a turn is not an answer node.
 */
function answerOf(range) {
  const node = range.commonAncestorContainer
  const el = node.nodeType === 1 ? node : node.parentElement
  const answer = el?.closest?.('.docpilot__answer')
  return answer && panel.value?.contains(answer) ? answer : null
}

const ask = createSelectionAsk({
  el: () => askEl.value,
  enabled: () => s.config.quote.fromAnswer,
  containerOf: answerOf,
  /**
   * Not while anything is running. A quote is a reference to a settled answer,
   * and a passage taken out of a stream is a passage the next frame rewrites —
   * the node behind that range is replaced every 90ms while a turn is live.
   */
  eligible: (answer) => {
    const turn = s.turns.find((t) => t.id === answer.dataset.turn)
    return !s.busy && !!turn && (turn.state === 'complete' || turn.state === 'aborted')
  },
  /**
   * The THREAD's box, not the panel's: the panel includes the header and the
   * composer, and a button clamped to that would sit on top of the title while
   * pointing at a line scrolled up under it.
   */
  boxOf: () => thread.value?.getBoundingClientRect() || null,
  clamp: clampQuote,
  coarse: () => coarse.value,
  /**
   * `range.toString()` pulls a citation superscript's digit into the middle of a
   * sentence — "the scope picker1 lists" — because the marker is a real text
   * node inside the answer. Dropping the markers from a clone first is what
   * makes the quote read as the documentation it came from.
   */
  strip: (frag) => {
    for (const cite of frag.querySelectorAll?.('.docpilot__cite') || []) cite.remove()
  },
})

const askOpen = ask.open
const askStyle = ask.style
const askBelow = ask.below
const canPopover = ask.canPopover
const closeAsk = ask.close
const reposition = ask.reposition

// The factory hands back whether a selection was accepted; presenting it is the
// component's job, because only the component knows when its own template has
// flushed the popover into the DOM.
const onSelectionAccepted = (accepted) => {
  if (accepted) nextTick(() => ask.present())
}

function takeQuote() {
  const text = ask.take()
  if (!text) return
  quote.value = text
  s.announce = T('announce.quoteAdded')
  nextTick(() => panel.value?.querySelector('.docpilot__field textarea')?.focus())
}

function dropQuote() {
  quote.value = ''
  s.announce = T('announce.quoteRemoved')
  nextTick(() => panel.value?.querySelector('.docpilot__field textarea')?.focus())
}

/**
 * ── the passage behind a citation — ui-specs/009 ────────────────────────────
 *
 * One id, so at most one passage is open across the whole thread. Two open
 * passages in a 420px column is a column of quotations with an answer somewhere
 * in it, and the reader opened one to check one thing.
 *
 * The text itself comes from the store — see `passageFor`, which prefers the
 * chunk THIS turn put in front of the model and falls back to the index by id.
 */
const openPassage = ref<string | null>(null)
const passage = (turn, src) => session.passageFor(turn, src)
const passageHtml = (turn, src) => session.passageHtml(turn, src)
const togglePassage = (id) => (openPassage.value = openPassage.value === id ? null : id)

/**
 * The copied answer carries its sources — ui-specs/009, `citations.inCopy`.
 *
 * `answerText` alone is what this used to write, and the markers survive the
 * paste with nothing behind them: `[1]` in a ticket is worse than no citation at
 * all, because it looks like provenance. Absolute URLs, because the paste lands
 * outside the site that could have resolved a route.
 *
 * Built from `turn.sources`, which is the list the reader is looking at — not
 * from the answer text, which would mean parsing markers back out of prose the
 * model wrote.
 */
function withSources(turn) {
  const text = turn.answerText || ''
  if (!s.config.citations.inCopy || !turn.sources?.length) return text
  const origin = typeof location === 'undefined' ? '' : location.origin
  const lines = turn.sources.map((src) => {
    const href = src.origin || `${origin}${src.href}`
    return `${src.n}. [${src.title}](${href})`
  })
  return `${text}\n\n${T('citation.copyHeading')}\n${lines.join('\n')}`
}

/**
 * The whole conversation as Markdown — ui-specs/009, `history.exportThread`.
 *
 * Per-turn copy already existed; what a support engineer pastes into a ticket is
 * the THREAD, and reassembling one from four separate copies is the work this
 * removes.
 *
 * Through `withSources`, so the export honours `citations.inCopy` exactly as a
 * single answer does — two copy paths that disagree about provenance would be
 * two answers to one question.
 *
 * The quote rides as a blockquote above its question, which is where it sits on
 * screen and what Markdown already has for it.
 */
const threadCopied = ref(false)

async function copyThread() {
  const text = s.turns
    .map((turn) => {
      const quoted = turn.quote ? `> ${turn.quote.replace(/\n/g, '\n> ')}\n\n` : ''
      return `## ${turn.question}\n\n${quoted}${withSources(turn)}`
    })
    .join('\n\n---\n\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return /* clipboard denied — the thread is still selectable */
  }
  threadCopied.value = true
  setTimeout(() => (threadCopied.value = false), 2000)
  s.announce = T('announce.threadCopied')
}

async function copy(turn) {
  try {
    await navigator.clipboard.writeText(withSources(turn))
    turn.copied = true
    setTimeout(() => (turn.copied = false), 2000)
    s.announce = T('announce.copied')
  } catch {
    /* clipboard denied — the answer is still selectable */
  }
}

// Its own flag, not `turn.copied`: there are two copy buttons in a turn now,
// and one flag would light the tick on both. Neither field is in `makeTurn` and
// neither reaches the archive — `slimTurn` builds a whitelist.
async function copyQuestion(turn) {
  try {
    await navigator.clipboard.writeText(turn.question)
    turn.questionCopied = true
    setTimeout(() => (turn.questionCopied = false), 2000)
    s.announce = T('announce.questionCopied')
  } catch {
    /* clipboard denied — the question is still selectable */
  }
}

/**
 * ── editing a question ──────────────────────────────────────────────────────
 *
 * The state is LOCAL, and two refs rather than a flag on each turn. Three
 * reasons, in order of weight: a turn is the transcript — it is archived,
 * attached to a feedback report and handed to the model, and a draft is none of
 * those; one `editingId` makes "at most one editor is open" structurally true
 * instead of an invariant somebody has to maintain in a loop; and the object a
 * flag would live on is the one `editTurn` destroys.
 *
 * `editing` and `draft` are already the prompt instruction's, which is the same
 * pattern one layer down.
 */
const editingId = ref<string | null>(null)
const editDraft = ref('')
const canSaveEdit = computed(() => editDraft.value.trim().length > 0)

function startTurnEdit(turn) {
  if (s.busy) return
  editingId.value = turn.id
  editDraft.value = turn.question
  nextTick(() => {
    const ta = panel.value?.querySelector(`#dp-edit-field-${turn.id}`)
    if (!ta) return
    fit(ta)
    ta.focus()
    // Stated, not assumed: focusing a textarea that already has a value does
    // not put the caret at the end in every engine, and a reader who opens an
    // editor to add a word should not have to press End first.
    ta.setSelectionRange(ta.value.length, ta.value.length)
  })
}

function cancelTurnEdit() {
  const id = editingId.value
  editingId.value = null
  editDraft.value = ''
  // Back to the control that opened it — `refocusThumb`'s rule. The row is
  // hover-revealed, but focus keeps it visible through `:focus-within`.
  nextTick(() => panel.value?.querySelector(`#dp-edit-${id}`)?.focus())
}

function saveTurnEdit(turn) {
  if (!canSaveEdit.value) return
  const next = editDraft.value.trim()
  // Unchanged text is a cancel, not an ask: re-running it would destroy an
  // answer that is already on screen to get another one to the same question.
  if (next === turn.question) return cancelTurnEdit()
  threadFollow.repin()
  closeAsk()
  // Left open on a refusal — busy, degraded, or a conversation swapped out from
  // under the click — so a draft is never dropped into a thread it never reached.
  if (!session.editTurn(turn, next)) return
  editingId.value = null
  editDraft.value = ''
  // The turn this editor belonged to no longer exists, so focus would land on
  // <body>. The thread is where the replacement appears, and it is a named,
  // focusable region already.
  nextTick(() => thread.value?.focus({ preventScroll: true }))
}

/**
 * Which turns can be asked again.
 *
 * Not the credential or social ones. Both settle from a template with no model
 * call — `detectSocial` and `redactSecrets` decide them before retrieval — so a
 * second run returns the identical words, and a control that visibly does
 * nothing is worse than an absent one. The credential turn already carries the
 * button that IS its retry: "ask without the secret".
 *
 * Everything else qualifies, refusals first. `no-evidence` is a verdict about
 * one retrieval, and retrieval moves with the index, the scope and whether the
 * embedder was reachable at the time.
 */
const canRetry = (turn) =>
  (turn.state === 'complete' || turn.state === 'no-answer' || turn.state === 'aborted') &&
  turn.refusal?.cause !== 'credential' &&
  turn.refusal?.cause !== 'social'

function retryTurn(turn) {
  if (s.busy) return
  threadFollow.repin()
  closeAsk()
  session.retryTurn(turn)
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  const turn = s.turns.find((t) => t.id === editingId.value)
  if (turn) saveTurnEdit(turn)
}

// The built-in three now live in switches.js, beside the resolver, because
// `docpilot index` bakes WHAT THE PANEL WILL SHOW and cannot import a constant
// out of a .vue file. Two copies of the list would bake questions the reader
// never sees — and the SLICE was the second copy of the NUMBER: this line read
// `.slice(0, 3)` while `questionsOf` sliced at `SUGGESTION_LIMIT`, so the
// warning an author reads and the list a reader gets were free to disagree.
//
// Suppressed under a narrower scope: the defaults are almost certainly outside
// it and the gate would refuse all three on contact. What goes there instead is
// `scopedPages` below — ui-specs/009.
const suggestions = computed(() => {
  if (s.scope.kind !== 'all') return []
  const configured = s.config.suggestions.questions
  return (configured.length ? configured : DEFAULT_SUGGESTIONS).slice(0, SUGGESTION_LIMIT)
})

/**
 * The pages the reader scoped to — ui-specs/009, `suggestions.scoped`.
 *
 * Not capped and not scrolled on its own: the empty state lives inside the
 * thread, which is already the panel's one scroller, so a long scope simply
 * makes it longer. A second scroller inside a scroller is what the dock and the
 * picker have to be, and neither of them is inside this one.
 */
const scopedPages = computed(() => {
  if (!s.config.suggestions.scoped || s.scope.kind === 'all' || !s.index) return []
  const known = new Map(s.index.manifest.pages.map((p) => [p.path, p]))
  return s.scope.paths.map((path) => known.get(path)).filter(Boolean)
})

/**
 * Where to go next, from the corpus — ui-specs/009, `suggestions.followUps`.
 *
 * The headings on the pages this turn cited, minus the ones it cited. No model
 * call, in scope by construction, and **nothing invented**: the wording is a
 * template that is grammatical for any heading, which is exactly the difference
 * between this and the heading-derived openers 009 rejected for the default-on
 * case. A generated question can name a section the corpus does not have; this
 * cannot, because every string in it came out of the index.
 *
 * The newest turn only. Recomputed per call rather than memoised on the turn —
 * it is cheap, and a field on the turn is a field `slimTurn` would have to
 * decide about and the archive would have to carry.
 */
const FOLLOW_UPS_MAX = 3

function followUps(turn) {
  if (!s.config.suggestions.followUps || !s.index) return []
  if (turn !== s.turns[s.turns.length - 1] || turn.state !== 'complete') return []
  if (s.busy || !turn.sources?.length) return []

  const pages = new Set(turn.sources.map((src) => String(src.id).split('#')[0]))
  const used = new Set(turn.sources.map((src) => src.title))
  const out = []
  for (const chunk of s.index.chunks) {
    if (out.length >= FOLLOW_UPS_MAX) break
    if (!pages.has(chunk.path) || !chunk.title || used.has(chunk.title)) continue
    used.add(chunk.title)
    out.push(T('empty.followUp', { heading: chunk.title }))
  }
  return out
}

/**
 * The first-visit line — ui-specs/009, `ui.firstRunHint`, off by default.
 *
 * WITHHELD WHEN NEITHER QUOTING SWITCH IS ON. The hint names one gesture, and a
 * panel that does not answer that gesture must not advertise it — the same rule
 * the three `disclaimer` variants keep about what they claim.
 *
 * `localStorage` directly rather than through history.js's store: this is one
 * boolean about this device, it outlives the tab on purpose, and a private-mode
 * throw here should cost the hint and nothing else.
 */
const HINT_KEY = 'docpilot:hint-seen'
const hintSeen = ref(true)

const showHint = computed(
  () =>
    s.config.ui.firstRunHint &&
    !hintSeen.value &&
    (s.config.quote.fromAnswer || s.config.quote.fromDocs),
)

function dismissHint() {
  hintSeen.value = true
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    /* private mode — the hint simply returns on the next visit */
  }
}

// The one place the reader is told what they may ask about, so it names the
// product when there is one to name and stays honest when there is not.
const placeholder = computed(() =>
  s.config.product
    ? T('composer.placeholder', { product: s.config.product })
    : T('composer.placeholderNoProduct'),
)

// Three-way, because the sentence names what actually travels. "Not-helpful
// reports are sent" is false the moment a thumb up is transmitted too, and
// equally false when an endpoint is configured and `send: 'none'` switches it
// off — a disclaimer that overstates is worse than none.
const disclaimer = computed(() => {
  const { feedbackEndpoint, feedback } = s.config
  if (!feedbackEndpoint || feedback.send === 'none') return T('disclaimer.base')
  return T(feedback.send === 'down' ? 'disclaimer.withFeedback' : 'disclaimer.withRating')
})

/**
 * The footnote's one word of attribution — `ui.credit`, on by default.
 *
 * Hardcoded rather than configurable: this is the link to the project the panel
 * IS, and a site that wants a different destination wants a different sentence,
 * which is what `ui.credit: false` plus their own markup gives them. Held equal
 * to `homepage` in package.json by packaging.test.js, because those two have
 * disagreed before.
 */
const CREDIT_URL = 'https://docpilot-nine.vercel.app'

/**
 * WHETHER A SEPARATOR BELONGS IN FRONT OF IT — the credit is the first thing on
 * this line that renders unconditionally, and a `·` belongs to what precedes it.
 *
 * Both of the segments before it are optional: the scope button is gone under
 * `scope.enabled: false`, and the disclaimer only arrives with the first answer.
 * With neither, a leading dot is the whole footnote's first character. The
 * disclaimer carries the same test for the same reason, one segment earlier.
 */
const creditSep = computed(() => s.config.scope.enabled || s.turns.length > 0)

/**
 * Whether this deployment HAS a daily allowance — the settings half of the
 * question, hoisted so the line below reads as the three conditions its docblock
 * names. `budget.js` owns the predicate; see `hasDailyAllowance`.
 */
const hasAllowance = computed(() =>
  hasDailyAllowance({
    dailyLimit: s.config.budget.dailyLimit,
    freePool: s.config.llm.freePool,
  }),
)

/**
 * What is left of the day, in one muted line under the field.
 *
 * THREE conditions, and each one is a way of getting it wrong:
 *
 *   · the switch. `budget.showRemaining` defaults OFF — the count a browser can
 *     compute is not the count a shared key has — so this is a site saying it
 *     knows its own allowance and wants it stated. Off retires the low-budget
 *     note below with it, and the no-embedder note beside it.
 *   · a DAILY ALLOWANCE — `hasDailyAllowance`, called with the same two facts
 *     `session.js` seeds the ledger's ceiling from: a `budget.dailyLimit` the
 *     site declared, or `llm.freePool`, true only where the answers come off the
 *     provider's own free catalogue. Either one makes the ceiling a count of
 *     REQUESTS per day; with neither there is no such ceiling to report and a
 *     fabricated "50" would be worse than silence.
 *
 *     BOTH ARMS, and that is the fix. This tested `freePool` alone, so
 *     `budget: {dailyLimit: 500, showRemaining: true}` on a metered provider was
 *     rationed against 500 all day and never told the reader the count — the one
 *     deployment being rationed was the one unable to see it. Before that it read
 *     `llm.models`, a different question with a similar shape: config.js returns
 *     an author's own `chat.models` list for ANY provider, and a
 *     `{provider: 'openrouter', model: '…'}` free-pool config has no list at all.
 *     It is now literally the function `trustworthy` opens with, so the line and
 *     the rationing cannot disagree about who has an allowance — a claim that was
 *     made here once before and was not true.
 *   · a KNOWN snapshot. `s.budget` is null until something has been learned —
 *     a header, or a ceiling the project wrote down — and "? of ? left" is
 *     worse than no line. The finite checks repeat that here because a partial
 *     rate-limit read is normal: a `remaining` with no `limit` renders no
 *     fraction rather than the word `undefined`.
 */
const budgetLine = computed(() => {
  const snap = s.budget
  if (!s.config.budget.showRemaining || !hasAllowance.value) return ''
  if (!snap || !Number.isFinite(snap.remaining) || !Number.isFinite(snap.limit)) return ''
  return T('error.budgetLeft', { n: snap.remaining, limit: snap.limit })
})

/**
 * The other thing that line can say: this deployment has no embedder.
 *
 * `config.embed.lexicalOnly` — the DECLARED mode, `embed: false` — and not
 * `state.retrieval`, which is the same word arrived at by a different route. That
 * one is only known after a question has been asked, and this line has to be
 * readable before the reader types one; an embedder that was configured and could
 * not be reached is the other case, and it already has `refusal.degraded`.
 *
 * Under `budget.showRemaining` rather than a switch of its own, because it is the
 * same sentence from the reader's side: what is this next question limited to.
 * A site that asked the panel not to discuss its own limits is not told about
 * this one either.
 */
const embedNote = computed(() =>
  s.config.budget.showRemaining && s.config.embed.lexicalOnly ? T('error.noEmbedder') : '',
)

/** The two, joined — either alone, both, or nothing and no paragraph at all. */
const statusLine = computed(() => [budgetLine.value, embedNote.value].filter(Boolean).join(' · '))

// Whether the NEXT question will be answered in one model call. Read off the
// session rather than re-derived here: the plan is a decision, taken in one
// place, and a template that applied `oneShotBelow` itself would be a second
// place for it to drift.
const oneShot = computed(() => s.budgetMode === 'one-shot')

/**
 * The one-shot notice, said once and then retired.
 *
 * `sessionStorage`, not the device store the first-run hint uses: this is a fact
 * about TODAY's budget, and a reader who comes back tomorrow to a full quota
 * must not meet a warning about yesterday's. Once per tab, because the drop in
 * length is only surprising the first time and a line that reappears over every
 * question for the rest of the day is nagging.
 *
 * `due` is what the flag is spent on, and it includes the budget line itself:
 * a notice nobody could have seen must not count as having been given. It also
 * keeps the note honest after it has been armed — the budget can refill
 * mid-session, and "Running low" beside "40 of 50 left" is simply false.
 */
/**
 * ── the composer's draft — ui-specs/012 ──────────────────────────────────────
 *
 * `sessionStorage`, paired with `docpilot:conversation` rather than with the
 * `localStorage` archive, and for that key's own reason: a draft belongs to the
 * tab that is typing it. Two tabs are two questions.
 *
 * REDACTED BEFORE IT IS WRITTEN, and this is the part that is not optional. A
 * pasted key is caught before a turn exists, and every path that writes to
 * storage redacts first — the draft is the one text in this panel that reaches
 * disk BEFORE any of that machinery has seen it, which makes it the exact shape
 * of hole every other path has closed.
 *
 * GATED ON `history.enabled` AS WELL. That setting is published as "stops
 * recording AND clears what is already stored"; a draft surviving it would make
 * the sentence false. Which is also why a mount with either switch off REMOVES
 * the key rather than merely declining to write one.
 */
const DRAFT_KEY = 'docpilot:draft'
let draftTimer: ReturnType<typeof setTimeout> | null = null

const draftsOn = () => s.config.composer.draft && s.config.history.enabled

function keepDraft(text) {
  try {
    const clean = draftsOn() ? redactSecrets(text || '').clean : ''
    if (clean) sessionStorage.setItem(DRAFT_KEY, clean)
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* private mode — the draft does not survive, and nothing else changes */
  }
}

/**
 * Read once, at mount, and only into an EMPTY composer.
 *
 * Before `applyDeepLink`, which is the precedence that matters: `?dp-ask=` is an
 * intent the reader expressed a second ago by following a link, and a draft is
 * one they left behind. The deep link drains through `pendingQuestion` and
 * overwrites this.
 */
function restoreDraft() {
  try {
    if (!draftsOn()) return sessionStorage.removeItem(DRAFT_KEY)
    const saved = sessionStorage.getItem(DRAFT_KEY)
    if (saved && !input.value) input.value = saved
  } catch {
    /* see above */
  }
}

watch(input, (v) => {
  clearTimeout(draftTimer)
  // Clearing is IMMEDIATE, writing is debounced. `send()` empties the field, and
  // a reader who leaves inside the debounce window would otherwise come back to
  // a draft of the question they had just asked.
  if (!v) return keepDraft('')
  draftTimer = setTimeout(() => keepDraft(v), 400)
})

/**
 * The page is going away — ui-specs/012. Both halves of "keep what you have":
 * the turn that is still streaming, and the sentence still in the field, whose
 * debounce has not fired yet.
 */
function onLeaving() {
  session.saveIfRunning()
  clearTimeout(draftTimer)
  keepDraft(input.value)
}

const BUDGET_LOW_KEY = 'docpilot:budget-low'
const budgetLowSaid = ref(false)
const budgetLowDue = computed(() => oneShot.value && !!budgetLine.value)
const showBudgetLow = computed(() => budgetLowSaid.value && budgetLowDue.value)

// Whether anything the reader types would leave the device. A textarea whose
// contents go nowhere invites a sentence and silently discards it. The reason
// BUTTONS stay either way — they are useful in the local export, which
// `docpilot feedback pull --from` reads.
const commentable = computed(
  () =>
    s.config.feedback.comment &&
    !!s.config.feedbackEndpoint &&
    s.config.feedback.send !== 'none',
)

// Does a vote reach anywhere? Decides whether the action row stays visible at
// rest rather than appearing on hover.
const feedbackLive = computed(
  () => !!s.config.feedbackEndpoint && s.config.feedback.send !== 'none',
)

// The reasoning line counts up while reasoning is what is happening, and stops
// at its final value the moment the first answer token lands. One second is the
// resolution the number is read at, so it is also the tick rate — a rAF loop
// here would re-render the thread 60 times a second to move a digit once.
const tick = ref(0)
let tickTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => s.busy,
  (busy) => {
    clearInterval(tickTimer)
    if (busy) tickTimer = setInterval(() => (tick.value += 1), 1000)
  },
)
onBeforeUnmount(() => clearInterval(tickTimer))

function thoughtLabel(turn) {
  if (!turn.streaming || turn.answerText) return T('turn.thoughtFor', { n: turn.thoughtSeconds })
  void tick.value
  return T('turn.thinkingFor', {
    n: Math.max(1, Math.round((performance.now() - turn.startedAt) / 1000)),
  })
}

/**
 * The reasoning box is a fixed-height scroller, so live text has to be followed
 * the same way the thread is — and STOPPED the same way, which is what
 * `thoughtFollow` is for. A reader who scrolls up inside it is re-reading a
 * line the model has already moved past; dragging them back to the foot on the
 * next token makes the box unreadable while it is the only thing on screen.
 *
 * The box is found BY THE LAST TURN'S ID, not as the last `.docpilot__thoughts`
 * in the panel. Those were the same node only while the disclosure was the
 * stream's to control: now that a reader can collapse the live one and open an
 * older one, "the last box in the document" is somebody else's reasoning.
 */
const thoughtBox = () => {
  const last = s.turns[s.turns.length - 1]
  return last ? panel.value?.querySelector(`#dp-thoughts-${last.id}`) : null
}
const onThoughtScroll = (turn: Turn, e: Event) => {
  // Only the live box follows anything, so only the live box can unfollow.
  if (turn === s.turns[s.turns.length - 1]) thoughtFollow.read(e.target)
}
let thoughtQueued = false
watch(
  () => s.turns[s.turns.length - 1]?.thought,
  (now, before) => {
    // The box was emptied — a new turn, or a second model call inside this one,
    // which `onStream`'s `start` clears it for. Nothing the reader scrolled up
    // to read is in there any more, so the hold on it is released with the text.
    if (!now || (before && now.length < before.length)) thoughtFollow.repin()
    if (thoughtQueued) return
    thoughtQueued = true
    requestAnimationFrame(() => {
      thoughtQueued = false
      thoughtFollow.follow(thoughtBox())
    })
  },
)

const statusLabel = computed(() => {
  const p = s.status
  if (!p) return ''

  /**
   * A wait long enough to be worth naming outranks the phase — ui-specs/012.
   *
   * `tick` is READ, not used: it already advances once a second while a turn
   * runs (the reasoning counter needs it), and touching it here is what makes
   * this computed re-evaluate on that same beat instead of on a timer of its
   * own. `waitingKey` returns null while anything is painting, which is why the
   * phase below stays the normal answer.
   */
  void tick.value
  const turn = s.turns[s.turns.length - 1]
  const key = waitingKey({
    elapsedMs: turn ? performance.now() - turn.startedAt : 0,
    quiet: !!turn && !turn.answerText && !turn.thought,
    escalate: s.config.ui.waitingEscalation,
  })
  if (key) return T(key)

  if (p.phase === 'reading') {
    return p.label ? T('status.readingPage', { label: p.label }) : T('status.reading')
  }
  const known = ['indexing', 'thinking', 'listing', 'writing']
  return T(`status.${known.includes(p.phase) ? p.phase : 'searching'}`)
})

/**
 * "the docs" in a sentence, where the picker says "All docs" on a button.
 *
 * Decided on the scope's KIND, never on its label. Comparing the label against
 * the literal `'All docs'` is what this used to do, and it is a trap with no
 * error attached: the moment that one string is translated — or a section is
 * ever named "All docs" — the comparison silently fails and every refusal line
 * reads "I couldn't find this in All docs." The kind is the fact; the label is
 * one rendering of it.
 */
const scopeWord = (kind, label) => ((kind ?? 'all') === 'all' ? T('refusal.allDocsShort') : label)
const shortScope = (refusal) => scopeWord(refusal?.scopeKind, refusal?.scopeLabel)
// The same word for a turn that ANSWERED with passages. A refusal carries its
// scope flattened into `refusal.scopeKind`/`scopeLabel`; a results turn has the
// frozen `turn.scope` itself, and one renderer for both is what keeps "All docs"
// from appearing in a sentence that reads "in All docs".
const turnScope = (turn) => scopeWord(turn?.scope?.kind, turn?.scope?.label)
const settledLine = (turn) => {
  // A credential turn settles before retrieval, so it has no provenance line to
  // print: "Searched the docs" would describe work that did not happen. A social
  // turn settles even earlier, for the same reason and with the same result.
  if (turn.refusal?.cause === 'credential' || turn.refusal?.cause === 'social') return ''
  // A refusal carries its scope flattened onto `turn.refusal`; every other
  // settled turn — a search-only one above all — has only the frozen
  // `turn.scope`. Reading the refusal's copy unconditionally made a scoped
  // search-only turn print "Searched the docs" for a search that was confined to
  // one page, because `refusal.scopeKind` was undefined and defaulted to 'all'.
  const scope = turn.refusal ? shortScope(turn.refusal) : turnScope(turn)
  if (turn.refusal?.cause === 'not-answerable' || turn.state === 'error') {
    return T('refusal.searchedAndRead', { scope, n: turn.refusal?.pagesRead ?? 0 })
  }
  return T('refusal.searched', { scope })
}
/**
 * "I couldn't find this" is a claim about the DOCS. It is only true when the
 * search actually ran — when the embedder is down, retrieval is BM25 alone, and
 * on an English corpus a question in another language has no lexical overlap to
 * score at all. Saying the docs lack the answer there blames the corpus for a
 * broken dependency and sends the reader looking for a page that exists.
 *
 * The credential lead is the same rule taken one step further: nothing was
 * searched at all, and unlike every other line in this panel it is written in
 * the reader's language, because the host wrote it instead of the model.
 */
const leadLine = (turn) =>
  turn.social?.copy.lead ||
  turn.credential?.copy.lead ||
  (turn.refusal?.degraded
    ? T('refusal.degraded')
    : T('refusal.notFound', { scope: shortScope(turn.refusal) }))

// When the quota comes back, as a clock time in the reader's locale — see
// session.js, which owns it because the sentence is SPOKEN as well as shown. A
// rate-limited turn is announced with its reset line attached, and a second
// formatter here would eventually disagree with that one about the only fact in
// the turn a reader can act on.
const resetLine = session.resetLine

function goSource(href) {
  if (mobile.value) close()
  router.go(href)
}

// An imported page's row points at the original on another host: the browser
// opens it in the new tab the markup already asks for, and the panel stays where
// it is — closing the drawer for a tab the reader did not navigate to would lose
// the thread for nothing. Everything else is SPA navigation, as before.
function onSourceClick(e: MouseEvent, src: any) {
  if (src.origin) return
  e.preventDefault()
  goSource(src.href)
}

/**
 * The reader's own words, marked inside a search-only snippet.
 *
 * ESCAPED FIRST, ALWAYS. The snippet is corpus text — a page author's prose,
 * which can contain angle brackets and does on any page documenting HTML.
 * Escaping and then inserting our own `<mark>` is the order that makes the marks
 * the only markup in the string; matching first and escaping after would escape
 * the marks too, and escaping neither is an injection.
 *
 * The passage disclosure is the other place corpus text becomes `v-html`, and it
 * arrives already parsed: markdown-it runs with `html: false`, so an author's
 * angle bracket is escaped there by the renderer rather than by this function.
 *
 * COMPUTED AT RENDER, NEVER STORED. A results turn is persisted to the archive,
 * and marked-up HTML in a stored record is a hazard that outlives the render it
 * was correct for — the query that produced it is right there in `turn.question`,
 * so the marks can always be re-derived.
 *
 * `terms()` rather than a split on spaces, so the tokens marked are the tokens
 * the retriever actually matched on: stop words are dropped, an identifier keeps
 * its dots, and a one-character query marks nothing rather than every letter.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

function markQuery(snippet, question) {
  const safe = escapeHtml(snippet)
  const words = [...new Set(terms(question || ''))].filter((w) => w.length >= 2)
  if (!words.length) return safe
  // Longest first, so `window.initeditor` marks as one run rather than being
  // broken up by an earlier match on `window`.
  const pattern = words
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  // Escaped text, so `&amp;` and `&lt;` are in the haystack — a term can only
  // match inside one of those entities if the reader typed `amp` or `lt`, and
  // marking a substring of an entity would break it. The lookarounds keep the
  // match off any run that is part of an entity.
  return safe.replace(new RegExp(`(?<![&#\\w])(${pattern})(?![\\w;])`, 'giu'), '<mark>$1</mark>')
}

/**
 * Arrow keys move between result rows — a roving tabindex, scoped to the list.
 *
 * One tab stop for the whole list rather than one per row: eight results is
 * eight tab presses to get past, and a reader who wants the composer back should
 * not have to walk the answer to reach it. `resultFocus` is which row holds that
 * stop; the arrows move it, Enter follows the link the browser already activates.
 *
 * Keyed per turn, because a thread can hold several results turns and a single
 * index would move all of them at once.
 */
const resultCursor = ref({})
const resultFocus = (turn) => resultCursor.value[turn.id] || 0

function onResultsKey(e: KeyboardEvent, turn: Turn) {
  const n = turn.results.length
  if (!n) return
  const at = resultFocus(turn)
  let next = at
  if (e.key === 'ArrowDown') next = Math.min(at + 1, n - 1)
  else if (e.key === 'ArrowUp') next = Math.max(at - 1, 0)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  else return
  e.preventDefault()
  resultCursor.value = { ...resultCursor.value, [turn.id]: next }
  nextTick(() => {
    const list = e.currentTarget
    list?.querySelector?.(`[data-dp-result="${next}"]`)?.focus()
  })
}

// The answer is v-html, so its links have no Vue handlers of their own: without
// this delegation a citation marker is a full page load out of the SPA, which
// on mobile also drops the panel it was opened from.
const linkedCite = ref<HTMLElement | null>(null)

function onAnswerClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const btn = e.target.closest?.('[data-copy-code]')
  if (btn) return copyCode(btn)
  const a = e.target.closest?.('a[href]')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href?.startsWith('/')) return
  e.preventDefault()
  goSource(href)
}

// The copy button lives inside v-html and has no component instance, so its
// confirmation is a class on the clicked element rather than reactive state. A
// re-render mid-stream replaces the node and drops both, which is correct: the
// block it was confirming no longer exists.
const copiedTimers = new WeakMap()

async function copyCode(btn) {
  const wrap = btn.parentElement
  const pre = wrap?.querySelector('pre')
  if (!pre) return
  const raw = pre.textContent ?? ''
  // A shell block is copied to be run, and a leading prompt breaks that.
  const text = wrap.dataset.lang === 'bash' ? raw.replace(/^ *(\$|>) /gm, '') : raw
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return /* clipboard denied — the code is still selectable */
  }
  btn.classList.add('is-copied')
  clearTimeout(copiedTimers.get(btn))
  copiedTimers.set(btn, setTimeout(() => btn.classList.remove('is-copied'), 2000))
  // A distinct string from the turn-level 'Copied': the polite region watcher
  // fires on change, so reusing it would go unannounced right after one.
  s.announce = T('announce.codeCopied')
}

// Pointing at a marker lights the row it goes to. UI-SPEC 573: no timer, no
// coarse-pointer branch — a touch that lands on the marker navigates anyway.
function onCiteEnter(e: MouseEvent) {
  const cite = e.target.closest?.('.docpilot__cite')
  linkedCite.value = cite ? Number(cite.dataset.cite) : null
}
/**
 * The host's own search, offered by the degraded and error states as the thing
 * to do instead — and whether to offer it at all.
 *
 * A CONFIGURED SELECTOR IS NOT ENOUGH; the element has to be on the page. Every
 * host's search is optional at the site level: DocSearch is opt-in on
 * Docusaurus, and VitePress renders no search box for a project that configured
 * none. So a binding's selector says "this is what search looks like here", not
 * "there is search here", and the difference is a button that clicks nothing —
 * measured on a stock `create-docusaurus` site, where the offer appeared and did
 * nothing.
 *
 * Gated on `s.open` so the lookup runs each time the panel opens rather than
 * being cached from the first: a computed over a `querySelector` has no reactive
 * dependency on the DOM, and a host whose search box mounts lazily would
 * otherwise be judged once, too early, forever.
 */
const hasSearch = computed(() => {
  if (!s.open || typeof document === 'undefined') return false
  const selector = hostConfig(s.config).search
  return !!selector && !!document.querySelector(selector)
})
function openSearch() {
  const selector = hostConfig(s.config).search
  if (selector) document.querySelector(selector)?.click()
}

// The VALUES are stable — they are recorded in feedback reports and compared
// across runs. Only their labels are translated, which is why the table holds
// no copy any more.
const REASONS = ['wrong', 'incomplete', 'not-in-docs', 'bad-links']

/**
 * A reference into the sprite `DocPilotIcons` publishes — ui-specs/001.
 *
 * The shape lives in exactly one `<symbol>`; this element carries the geometry
 * and the paint. That split is what makes `filled` a prop rather than a second
 * drawing: `fill` is inherited into the symbol's shadow tree from HERE, not from
 * where the symbol was defined, so one thumb renders outlined at rest and solid
 * when pressed.
 *
 * One glyph is drawn on a 24 box at 20px — the nav trigger's sparkle, reused
 * here rather than redrawn. Everything else is the 16×16 default it always was,
 * and the `viewBox` is stated so the symbol maps 1:1 into it either way.
 */
const Icon: FunctionalComponent<{ name: string; filled?: boolean }> = (props) => {
  const { box, size } = { ...GLYPH_DEFAULTS, ...(GLYPH_BOX[props.name] || {}) }
  return h(
    'svg',
    {
      viewBox: box,
      width: size,
      height: size,
      fill: props.filled ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    [h('use', { href: `#${symbolId(props.name)}` })],
  )
}
</script>
