# Retained originals and generated hook links

Native activation can create relative hook wrappers under
`.ponderosa-portable-review/active-git-hooks`. Retained-original export excludes
those generated links only when a durable local creation-operation receipt
proves the exact namespace. An editable working-root file or receipt transported
inside a package grants no authority.

The canonical lookup binds the actual original artifact owner, current root
path/device/inode, and the SHA-256 of the canonical retained user-data bytes. The
receipt records the namespace and each generated symlink's full inode identity,
name and exact link text. Allowed names are independently derived from the
original relative hook declarations. Missing authority, changed original/root,
extra files, incomplete names or replaced links refuse the retained export and
preserve every source byte. The verifier never follows a generated link, reads
its target, opens an old source host path, changes permissions or mutates the
working root. It rechecks the namespace again before export finishes.

The internal proof travels from the canonical local operation lookup through
`exportWorkingFiles` retained-original metadata. It is not accepted as a request
field or portable package property. Shared-root exports use the actual owner of
the unambiguous canonical original binding when looking up the receipt.

Regression source in `portable-git-recreation.test.mjs` covers exact proved
re-export, canonical serializer key ordering, missing proof, original/root
mismatch, forged workspace receipt, unknown files and replaced generated links.
Store issuance/lookup tests independently cover canonical authority. No tests,
build or browser execution were performed while implementing this change.
