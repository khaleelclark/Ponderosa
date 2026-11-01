# Provider process diagnostics

CLI and persistent JSON-RPC transports retain the latest 8,192 UTF-16 code units of stderr in memory. This bounds diagnostics per process; it is not a complete stderr archive. If the prefix is discarded, the reported tail starts with an explicit `stderr truncated` notice and the exact number of omitted UTF-16 code units. A Unicode surrogate pair crossing the cut is omitted together. Output at or below the boundary is unchanged.

Nonzero process-exit errors expose this notice through the existing error path. Persistent-runtime root-exit details include the same notice so the runtime owner can retain it in failure telemetry. Authored messages, history, stdout records and process lifecycle/fencing are not changed by this diagnostic buffer. Existing secret redaction at presentation/export boundaries still applies; never treat raw provider diagnostics as a secret-safe export.

Controlled coverage: `tests/providers/rpc-boundaries.test.mjs` runs actual local Node fake providers for both transports at and above the retention boundary, checks final cause/omission notices and observed teardown, and checks incremental Unicode-safe accounting. It requires no provider credentials or network.

The shared root-exit contract permits at most 8,320 UTF-16 units: the 8,192-unit tail plus a bounded omission notice. The server validates this bound before redacting diagnostics for persistence; oversized or malformed observations remain invalid. Valid formatted tails preserve exit code, signal and drain metadata.

Persistent Claude streaming sessions also use the shared tail helper, including
root-exit and EOF diagnostics. Their discarded prefix is counted cumulatively
instead of silently slicing each incoming chunk. Regression source lives in the
existing RPC-boundary test file; execution is deferred to the combined run.
