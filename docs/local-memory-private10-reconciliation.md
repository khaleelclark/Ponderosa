# Local Memory private.10 reconciliation

The integrated Ponderosa candidate uses the vendored
`@local-memory/mcp-node-private` 0.2.0-private.6 archive (SHA-256
`790d81ccabd862e956ce323e00a71c5f2c00042f58261138da16d53593923dba`).
The later private.10 archive (SHA-256
`1e12b25331f2641fc78b00f1fef5431042517f9832e677f16876a71ec277fde2`)
is an experimental side-by-side TypeScript implementation based on
`efe60974e2762d13ac1e8240b83b6887a85b6df0`, not a published or qualified
drop-in replacement. Its preserved handoff reports bounded Linux checks;
macOS and Windows native execution and production readiness were not qualified.

The archive's `dist/src/ponderosa.js` and `contracts/tools.json` are
byte-identical to private.6. Ponderosa does not launch the archive's standalone
MCP server for Claude: it exposes six host-defined memory operations through
its per-Run Claude MCP bridge, then enforces canonical Agent, Run, scope and
human capability authority in the server. Therefore private.10 standalone
protocol fixes do not automatically change Ponderosa's Claude behavior.

## Applicable changes brought into Ponderosa

- The Claude MCP bridge accepts canonical decimal strings `1`–`20` for
  `top_k` and lowercase `true`/`false` for `include_history`, while
  rejecting ambiguous values, non-scalars and out-of-range counts before host
  dispatch. The host still independently checks the exact selected tool,
  capability, scope, argument fields and limits; direct HTTP inputs stay strict.
- Invalid host arguments identify a fixed parameter or allowed range without
  echoing authored values or unrecognized keys. They return HTTP 400, rather
  than an internal-error status.
- Authorized reads, including direct lookup and search, can inspect an existing
  finite 384-dimensional zero embedding. Private audience and provenance checks
  remain unchanged; query vectors, new writes and portable imports/exports
  still require finite nonzero embeddings. This is not a full zero-vector repair
  or portability implementation.

The controlled bridge and disposable-Chroma tests exercise these boundaries;
they do not establish what caused the user's particular Claude problem. No real
Claude provider turn or user's memory was accessed, so real-provider behavior
and retrieval quality remain unqualified.

## Deliberately not copied

Private.10 adds standalone protocol coercions, Python-format whole-database
snapshots, metadata-only repair, configurable ranking and lazy reranker fallback.
Ponderosa's current host has separate authorization, scoped portable transfer,
durable intent and uncertain-effect holds. The experimental snapshot and
compensation paths explicitly lack atomic crash/unknown-HTTP recovery and
cannot replace those guards. Its date/update recency ranking and lazy reranker
fallback require product-level correctness, error-visibility and model-quality
validation before adoption. Remaining bad-vector metadata repair and complete
legacy zero-vector import/export are not claimed.

Private.10's standalone default/optional MCP tool discovery and authentication
changes apply to its own server, not automatically to Ponderosa's six-tool
bridge. Chunk-ID lookup already exists; this change does not add another
handoff mechanism. See `docs/codex-phase2-reconciliation-20261103.md` and
`docs/memory-scope-provisioning.md` for the independent Chroma CAS, cleanup,
provisioning, legacy identity and platform blockers.
