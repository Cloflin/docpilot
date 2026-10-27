/**
 * The ways out of the panel — a source row, a link inside an answer or a
 * passage, the host's own search — and the one control an answer's markup
 * carries, the code block's copy button.
 */
import { computed, type Ref } from 'vue'
import * as session from '../../docpilot/session.js'
import { hostConfig } from '../../docpilot/host.js'

export function useLinks({
  mobile,
  close,
  router,
  T,
}: {
  mobile: Ref<boolean>
  close: () => void
  router: { go: (href: string) => void }
  T: (path: string, vars?: Record<string, unknown>) => string
}) {
  const s = session.state

  function goSource(href) {
    if (mobile.value) close()
    router.go(href)
  }

  /**
   * A click the panel may take over: the primary button and no modifier.
   *
   * Ctrl/Cmd is a new tab, Shift a new window and Alt a download — the browser's,
   * not ours — and a click something further in already handled is not ours
   * either. The answer's delegation always asked this; the source rows did not,
   * so a Cmd-click on a citation navigated the tab the thread lives in, which on a
   * full-load host is the thread gone. ONE guard, because two copies are how the
   * second handler came to have none.
   */
  const isPlainClick = (e: MouseEvent) =>
    !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

  // An imported page's row points at the original on another host: the browser
  // opens it in the new tab the markup already asks for, and the panel stays where
  // it is — closing the drawer for a tab the reader did not navigate to would lose
  // the thread for nothing. Everything else is SPA navigation, as before.
  function onSourceClick(e: MouseEvent, src: any) {
    if (src.origin || !isPlainClick(e)) return
    e.preventDefault()
    goSource(src.href)
  }

  // The answer is v-html, so its links have no Vue handlers of their own: without
  // this delegation a citation marker is a full page load out of the SPA, which
  // on mobile also drops the panel it was opened from.
  function onAnswerClick(e: MouseEvent) {
    if (!isPlainClick(e)) return
    const target = e.target as Element
    const btn = target.closest?.('[data-copy-code]')
    if (btn) return copyCode(btn)
    const a = target.closest?.('a[href]')
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
    // A distinct string from the turn-level 'Copied': it names WHAT was copied.
    // It no longer has to differ to be heard — `say` makes a repeat a change.
    session.say(T('announce.codeCopied'))
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
    if (selector) document.querySelector<HTMLElement>(selector)?.click()
  }

  return { onSourceClick, onAnswerClick, hasSearch, openSearch }
}
