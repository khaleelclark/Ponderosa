# Native Git snapshot custody

Native adoption seals only planner-issued Git storage, known common/private/module pointers and the exact declared owned external graph. Snapshot creation and verification do not execute Git or consume mutable configuration includes.

Regular bytes use the existing pinned regular-file helper and bounded reads with inode/type/size/link-count and observational checks. Declared symlinks retain exact relative text and closed targets without following them, including passive cycles. Declared hardlinks must share their regular original inode with the complete expected count; unexpected or outside aliases are refused. External original bytes and declared metadata are checked against the compiled graph. Thin proof descriptors retain hashes instead of another payload copy.

The service forwards full byte-phase root/directory custody into native application and final metadata. Recovery support roots preserve the same issued identity. No current directory observation is relabeled as an original byte-phase receipt.

Added source-only closed-graph, outside-alias, FIFO replacement and actual live native configured dependency adoption regressions. No tests, builds or typechecks executed in this lane.

First seal and subsequent verification require the original root/directory receipts plus the native writer's held directory proof map. Storage and module pointer ancestry is checked before and during observation; a new directory observation never replaces that authority. Linked/reftable module capsules bind their worktree pointer to the private slot and separately prove common/private commondir and gitdir reciprocals. Failure after local branch creation returns the new Separate owner to unavailable while retaining its branch intent and partial data.
