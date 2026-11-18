# Configured bare Git dependency capsules

Configured dependency capture includes a bare repository inside a reviewed hook tree using the existing canonical Git capture and configuration sanitizer. Its repository record explicitly carries bare: true; common and private source directory provenance both identify the repository storage root. These source paths remain inert and never grant destination authority.

The source must be a canonical same-owner directory with explicit core.bare=true, no core.worktree, and no .git, commondir, or gitdir pointer. A held root plus bounded before/after configuration and complete native-original checks detect observed changes. This is not an atomic snapshot of an independently mutating repository.

Objects, refs, reflogs, index state where present, reftable, sparse and supported original families reuse the normal reader. Bare repositories have no initialized worktree module discovery. Other worktrees private slots are explicitly reported as omitted paths. A stored module that claims an external working tree still requires the existing qualified module-root contract; it is refused visibly rather than treated as inspected absence. Raw canonical storage and unsanitized config are not copied again as ordinary dependency files. Safe ordinary ancillary files and default hooks retain normal dependency custody; configured include/hook paths retain the existing explicit source grant and closed graph validation.

Well-known credential stores (.git-credentials, .netrc, _netrc, private SSH key basenames and PKCS12/PFX files) require credential re-entry and are visibly omitted. Public SSH keys remain ordinary data. Opaque user files still require the existing review; this is not a general secret detector.

The destination consumes explicit bare provenance and recreates a fresh owned bare storage root without a .git pointer or source worktree authority. Source tests cover canonical graph capture, sanitized configuration, ancillary/default hooks, private-file dispositions, malformed provenance and unchanged rejected source data. Execution is deferred to the consolidated product validation.
