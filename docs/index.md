---
layout: home
hero:
  name: Ask AI
  text: for VitePress
  tagline: A grounded answer panel for your docs. Retrieval in the browser, a gate that refuses before the model is called, citations checked against what was actually retrieved.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What it guarantees
      link: /concepts/guarantees
features:
  - title: No infrastructure
    details: The index is a static file built at deploy time and fetched by the browser. No vector database, no search service, no server beyond the one already serving your site.
  - title: Refuses before it spends
    details: A calibrated relevance floor settles off-topic questions with zero model calls and zero generated text. Thresholds are measured against your corpus, not copied from ours.
  - title: Citations you can check
    details: Every marker resolves to a chunk the host itself put in front of the model during that turn, and every link is verified to be a page that exists before it renders.
  - title: Honest about its limits
    details: It is a control against a weak or injected model, not a security boundary — and this documentation says so in the same words everywhere.
---
