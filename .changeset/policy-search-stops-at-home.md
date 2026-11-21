---
'@rundown-org/core': patch
---

Policy discovery keeps lilconfig's home-directory boundary when no `stopDir` is
given. `loadPolicy` / `loadPolicySync` forwarded an explicit
`stopDir: undefined`, which replaced lilconfig's default instead of deferring to
it: on lilconfig 3.1.3 the upward search for `.rundownrc*` ran past `$HOME` to
the filesystem root, and from 3.1.4 — which the site's WebContainer snapshot
resolves, because it installs without the workspace lockfile — every command
died in `path.resolve(undefined)` with
`The "paths[0]" argument must be of type string` before doing anything. The key
is now omitted unless the caller names a boundary.
