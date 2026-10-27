# 020 — An id is not text

> **Кратко.** Пока ответ печатается, id секции, который модель написала на месте
> `[n]`, был виден как сорок символов текста. Ссылкой он становился только в конце
> хода. Теперь до окончания хода такой id не рисуется, и после остановки тоже.

## Problem

`finish()` turns a section id the model wrote where a citation marker goes —
`[editor-configuration/image-storage#connecting-your-own-server]` — into its
`[n]` (engine-spec 039). It does that once, when the turn settles. Every frame
before it renders the model's own text, so the reader watched the id sit in the
sentence as plain text for the whole stream, and then saw it replaced by a
superscript. A stopped turn never settles, and kept the id for good.

The two-bullet instruction of 039 made this rare — none of 22 live answers
since wrote an id — but a model the package has not met can still write one.

## Decision

A render of text the turn has not settled — a stream frame, and what a stop
leaves behind — hides a bracket whose every part looks like a section id: a `/`
in it, or an anchor after its `#`. `renderAnswer(text, known, sources,
{pending: true})` does it on the token stream, beside the link filter, so link
text and code are never touched. `[C#]` has neither a slash nor an anchor and
stays. A number in brackets is left as it was: the settle links it.

The settled render, a restored answer and anything rendered with its sources
are unchanged.

## What a reader sees

The sentence streams without the id. At the settle the marker appears where it
was, as a numeric marker always has.
