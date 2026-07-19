# Ponderosa product wiki

This directory is the canonical, version-controlled product wiki. Each article
uses a small front matter contract consumed by the server-side documentation
index. Article IDs are durable capability references: changing an ID breaks a
`ponderosa://docs/<id>` reference, so rename titles instead of IDs.

Required fields are `id`, `title`, `summary`, `section`, and `order`. `related`
contains comma-separated article IDs. `code` and `assets` are semicolon-separated
`label|value` pairs. Code paths must be repository-relative and assets must stay
under `docs/wiki/assets/`.

The browser loads metadata first, one article body at a time, and bounded search
results. Agent prompts receive only the compact reference index; an active Run
retrieves full articles with `ponderosa_docs`.
