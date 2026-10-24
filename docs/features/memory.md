---
description: Follow-up questions work because the model sees the thread — the last answer whole, every older answer as a one- or two-sentence summary.
---

# Conversation memory

A follow-up like *and for a signature mismatch?* only makes sense next to what came before. DocPilot sends the model the thread, compressed: **the last answer whole**, and **each older answer as its summary**. The model writes that summary itself, in the same call that produces the answer, so memory costs no extra request.

<Demo>
  <MemoryDemo />
</Demo>

## How it works

1. Every answer is returned through the `answer` tool, which has a required `summary` field: one or two sentences.
2. The summary is stored with the turn (as `answerSummary`) but never shown to the reader.
3. On the next question, the newest question-and-answer pair goes to the model in full, up to 2,000 characters.
4. Every pair before it goes as the question plus its summary.

The model therefore keeps the details of what it just said, and the gist of everything earlier, without the prompt growing by a full answer every turn.

## Configuration

There is nothing to set: this is how 1.5 builds every request. Two environment variables restore the earlier behaviour, for measuring the difference:

```bash
DOCPILOT_HISTORY_MODE=skeleton   # older answers dropped, as in 1.4
DOCPILOT_ANSWER_SUMMARY=0        # no summary field in the answer tool
```

Measured against 1.4 on this site's eval set: clarifying follow-ups scored higher (+0.035 answer F1), rewrite requests slightly lower (−0.039), at about 6% more requests. The numbers and the arms that lost are in the [changelog](https://github.com/Cloflin/docpilot/blob/main/CHANGELOG.md).
