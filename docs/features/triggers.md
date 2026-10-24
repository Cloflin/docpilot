---
description: Four ways into the panel — a floating button, a navbar icon, a keyboard shortcut and a link under the article — and two ways it opens.
---

# Triggers and layout

A reader opens the panel from a floating button, from an icon beside your search box, with <kbd>⌘</kbd> <kbd>I</kbd> (<kbd>Ctrl</kbd> <kbd>I</kbd>), or from the *Didn't find it? Ask DocPilot* link under each article. Press a variant to see where it puts the door.

<Demo>
  <TriggersDemo />
  <template #code>

```ts
docPilot: {
  ui: {
    trigger: 'fab',      // 'nav' | 'screen' | 'fab' | 'both' | 'none' | an array
    panel: 'auto',       // 'popup' next to a floating button, else 'drawer'
    fabLabel: 'Ask AI',  // false for an icon-only button
  },
}
```

  </template>
</Demo>

## Options

| Key | Default | What it does |
|---|---|---|
| `ui.trigger` | `'fab'` | Where the buttons go. `'nav'` puts an icon beside search and a row in the mobile menu; `'fab'` a floating button; `'both'` all three; `'none'` no button. |
| `ui.panel` | `'auto'` | `'popup'` floats above the button; `'drawer'` takes the full height at the edge. `'auto'` picks the popup when there is a floating button. |
| `ui.fabLabel` | `true` | `true` shows *Ask AI*, a string shows that text, `false` shows the icon alone. |
| `ui.layout` | `'overlay'` | `'push'` narrows the page instead of covering it when the drawer opens. |
| `ui.background` | `'notify'` | An answer that finishes while the panel is closed puts a dot on the trigger; `'open'` reopens the panel instead. |
| `ui.prefetch` | `'hover'` | Starts fetching the index when the pointer reaches a trigger, so the first answer starts sooner. |

Below 960 px the panel is a full-screen sheet, whatever the setting. <kbd>⌘</kbd> <kbd>I</kbd> works on every page, even with `trigger: 'none'`; <kbd>Esc</kbd> closes the panel, or stops an answer that is still being written.

## Deep links

`composer.deepLink` (on by default) lets a link open the panel with a question already typed:

```
https://docs.example.com/guide/webhooks?dp-ask=How+do+retries+work&dp-scope=page
```

The question is filled in, never sent. `dp-scope=page` narrows the search to the page the link lands on.

More: [`ui`](/reference/config#ui) in the reference, and [The assistant panel](/guide/panel).
