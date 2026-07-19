---
id: documentation-references
title: Documentation for Agents
summary: Understand the compact product-documentation index and stable run-scoped retrieval used by Agents.
section: Reference
order: 90
related: troubleshooting,communication-scopes,getting-started
code: Documentation index|apps/server/src/documentation-reference/index.ts;Provider tool schemas|packages/core/src/managed-tools.ts
assets: Documentation flow screenshot|docs/wiki/assets/documentation-flow.png
---

The product wiki is useful to people and Agents without becoming a permanent prompt tax. Markdown in `docs/wiki/` is the authoritative content. The browser reads bounded metadata, search results, and one article at a time from the same server index used by the Agent capability.

## Compact prompt index

Every Run receives a short **Product documentation** reference block. It contains stable `ponderosa://docs/<id>` identifiers grouped by section and tells the Agent how to retrieve them. Article bodies, screenshots, and source links are not flattened into the prompt. Adding an article changes the versioned index and provider tool contract input without duplicating the article across private histories.

![Documentation retrieval flow screenshot](/api/wiki/assets/documentation-flow.png)

## On-demand retrieval

An active Run calls `ponderosa_docs` with one or more advertised references. Ponderosa validates the run capability, exact reference IDs, requested order, byte budget, cursor, and documentation version. The response pages UTF-8 Markdown and returns an opaque continuation cursor when content remains.

References are durable names, not authorization tokens. Retrieval authority is rechecked against the active Run. An invented ID fails closed, and a cursor cannot be reused with a different Run, reference order, content version, or byte budget.

## Authoring rule

Preserve an article's `id` once published. Titles and summaries may improve without breaking references. Use canonical vocabulary, link executable contracts and implementation files, keep secrets out of screenshots, and update docs in the same change that alters their product behavior.
