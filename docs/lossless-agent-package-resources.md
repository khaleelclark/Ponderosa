# Lossless large Agent packages

Full Agent/organization export, supported copy, staged JSON/binary import and
Branch composition use the same artifact codec. Large originals (at least
64 KiB) use gzip only when it reduces their wire size. `dataEncoding: "gzip"`
and `decodedSize` describe that encoding; `dataBase64` carries the compressed
bytes. Smaller/incompressible originals retain their ordinary base64 form.
The importer restores the exact original bytes, computes their original SHA-256,
and preserves artifact refs, metadata, history, reporting links and provenance
through the existing collision-remapping and transactional creation paths.
Compression never summarizes, truncates or replaces history.

Execution evidence is emitted in ordered parts with approximately 8 MiB of
retained rows each. Each part retains the original Agent/Project identity and
source sequence numbers, uses the existing execution-archive schema, and passes
the unchanged structured-secret inspector and archive validator. Reconstruct the
complete history by collecting all parts for the original Agent and ordering
events by `seq`; Run IDs retain their historical identity. Imported evidence
remains ordinary historical log artifacts and never becomes scheduler authority.
The existing full-export sensitive-data warning and secret exclusions still apply.

## Resource admission

- 2 GiB of serialized UTF-8 package JSON, shared by export, browser preview,
  download and staged import. Export counts retained wire bytes incrementally,
  including working originals and archive parts, rather than retaining an
  unbounded incompressible collection before refusal.
- 4 GiB of decoded original artifacts per complete package. Referenced originals
  count even if another Agent originally owned them. Previews use declared decoded
  sizes without inflating data; imports verify every declaration before creation.
- 64 MiB per original artifact and per execution-archive part. Gzip expansion is
  capped at the declared size, including concatenated members. Invalid base64,
  unsupported encodings, bad checksums, truncation, excess expansion and size
  mismatches refuse the whole import.
- Staging is bounded at 4 GiB. The existing 16 KiB import metadata, 10,000
  Agents, depth limits and serialized codec/import admission remain in force,
  with a 3 GiB worker heap limit and 60-second processing timeout.
- Streaming parsing uses a 6 GiB available-memory admission. Before decoding originals,
  an import also requires 6 GiB plus twice the complete decoded artifact size in
  available memory, respecting Node 24's usable-memory estimate (including reclaimable pages) and the process/cgroup ceiling. Insufficient capacity returns a retryable 503 before
  artifact allocation or destination creation. Cancellation is checked between
  original decodes and again before existing mutation/publication boundaries.

These are bounded current in-memory operations. The next step beyond the decoded
ceiling is a disk-backed original-publication plan rather than skipping validation. Current bounds refuse with an error and keep all
source data; no partial package is returned as success.

Encoded packages require a release with this codec. Older exact-field package
parsers refuse the additional fields. The separate one-time historical backup
normalizer explicitly refuses encoded inputs rather than treating compressed
bytes as originals; use the supported Agent package importer for those packages.

## Focused verification

The regression fixtures exercise exact SHA-256/byte round trips beyond the former
128 MiB aggregate, HTTP export, JSON and binary imports, supported cross-Chat copy,
corrupt/misdeclared gzip, cancellation before creation, original preservation,
archive histories larger than 64 MiB, private/organization boundaries, compressed
versus plain Shared originals, incompressible wire-budget refusal, staging
ownership, and historical-normalizer refusal before destination creation.
No provider account, live Agent mutation, service restart or deployment is needed.

The server worker and browser preview share an incremental JSON reader. UTF-8 is
decoded in bounded stream chunks; JSON.parse handles bounded string/primitive
tokens rather than the complete document. Depth, malformed JSON/UTF-8, numeric
token budgets, and a 448 Mi UTF-16-code-unit per-string guard remain explicit.
Duplicate keys and own `__proto__` fields retain JSON.parse semantics.

Package routes disable the ordinary idle socket timeout while owned processing
is active, so slow export/copy/validation can return their real status rather
than a proxy 502. The existing 120-second request-body deadline and staged
byte/ownership admission remain unchanged. A native HTTP fixture uses a 25 ms
idle timeout and proves a larger export completes beyond that interval.
