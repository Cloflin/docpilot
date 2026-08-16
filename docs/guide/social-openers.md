# Social openers

Readers say hello first. This one recognises that **before the gate**, so the assistant's opening move is an introduction rather than a refusal.

## Why it exists

The gate runs before any model call and passes only what the documentation can support. "Hello" carries no documented subject, so both channels score at roughly zero, the turn ends on `no-evidence`, and the panel answers:

> I couldn't find this in the docs.

That verdict is **correct**. The outcome is wrong, and it is wrong in the most expensive place available: a greeting is the most common first thing anyone types, so the assistant's first act is to tell the reader it failed. Measured on the shipped panel, it reads as a broken feature rather than a scope boundary, and the reader leaves.

This is the same shape as [credentials in questions](/guide/credentials), and it sits beside it for the same reason: the gate's answer is right, so the fix cannot be a threshold. It has to be a class of input recognised earlier and settled locally.

## What happens

The turn settles in the browser with **no model call**. The reader sees, in their own language:

> **Hi! I answer questions about Acme Editor.**
>
> Anything these pages cover — setup, configuration, the APIs, whatever is written down. I answer from the pages themselves and link the one each answer came from.
>
> What are you building? Pick one below, or just describe what you are stuck on.
>
> `How do I get started?` · `How do I authenticate requests?`

The suggestion rows repeat here on purpose: an invitation with nothing to act on is the refusal it was written to replace.

## No model call, and never one

The reply is a template, not a generation. Three reasons, in order of weight:

- a model handed no evidence is exactly the configuration that invents product behaviour, and "hello" is not worth that risk;
- the copy is reader-facing UI and belongs in a diff where it can be reviewed;
- a greeting costs zero tokens instead of a round trip.

`temperature` is therefore not a lever here and never will be. Nothing is sampled.

## What it deliberately does not do

**It does not intercept a greeting attached to a real question.** "Hi, how do I authenticate requests?" carries a subject, and answering it with a wave would be worse than the refusal this exists to remove.

The patterns are anchored to the **whole input**, and anything over 64 characters is a question whatever it opens with. Only an input that is social and nothing else is claimed; everything else falls through untouched.

This matters more than it sounds: the check runs *before* the gate, so a false positive answers a real question with a greeting. The conservative anchoring is the guard, and it is tested against both halves — greetings that must be claimed, and greeting-prefixed questions that must not be.

## Four kinds, eighteen languages

`greeting`, `identity` ("who are you", "what can you do"), `thanks`, `farewell`. Identity is matched ahead of greeting, because "hi, who are you" is both and the identity answer is the more useful of the two.

The copy ships in eighteen languages, chosen by the same script-and-function-word detector the credential warning uses — the language the reader **typed**, not the locale of the page. A farewell carries no invitation and no suggestions; the rest do.

## Making it yours

The shipped copy names no product: it says "this documentation". Two ways to change that, and they do different things:

```js
docPilot = {
  // Names the product everywhere, in one line, in every language.
  product: 'Acme Editor',

  // Replaces one sentence in one language, and keeps the rest.
  i18n: {
    locales: {
      ru: {
        translations: {
          reply: { social: { greeting: { lead: 'Привет! Спрашивайте про Acme Editor.' } } },
        },
      },
    },
  },
}
```

`product` is not interpolated into the shipped `lead`, deliberately: "I answer questions about {product}" only reads correctly in English, and a neutral default substituted into a case-marked slot produces broken grammar in half the table. A project that wants its name in the greeting writes the whole sentence, per locale, where a human can read it. See [Translating the panel](/guide/i18n).
