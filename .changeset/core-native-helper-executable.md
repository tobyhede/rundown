---
'@rundown-org/core': patch
---

Keep the `rd-landlock` sandbox helper executable in the packed package.
`pnpm pack` writes every file as 0644 unless it is a `bin` entry or is listed in
`publishConfig.executableFiles`, so an installed `@rundown-org/core` held a
helper that could not be run and every sandboxed step command was refused with
"Sandbox unavailable". The two helpers are now listed in
`publishConfig.executableFiles`.
