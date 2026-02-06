# Scripting Standards

Standards for portable, usable scripts in the Rundown ecosystem.

## Decision Guide

| Complexity | Approach |
|-----------|----------|
| < 20 lines, just glue | Bash script |
| Argument parsing, logic, error handling | `tsx` script with `commander` or `yargs` |
| Needs to work on Windows | Always Node/TypeScript |
| CI-only, Linux guaranteed | Bash is fine |

Prefer `#!/usr/bin/env node` (or `tsx`) scripts over bash when possible. You get cross-platform portability, proper argument parsing, and consistent behavior. Use bash for thin wrappers and CI glue.

## Bash Scripts

### Header

Every bash script starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
```

- `env bash` — portable shebang (don't hardcode `/bin/bash`)
- `set -e` — exit on error
- `set -u` — error on undefined variables
- `set -o pipefail` — catch failures in pipes

### Portability

- Stick to POSIX coreutils (`grep`, `sed`, `find`, `mkdir`, `cp`)
- Avoid bashisms like `[[ ]]` if targeting `/bin/sh`; if you require bash, the `env bash` shebang makes that explicit
- Use `command -v` not `which` (POSIX)
- Use `$(...)` not backticks
- Use `printf` over `echo` for anything non-trivial

### Argument Parsing and Help

Minimal pattern that covers most cases:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [options] <argument>

  Does the thing.

Options:
  -h, --help     Show this help
  -v, --verbose  Verbose output
  -n, --dry-run  Show what would happen

Examples:
  $SCRIPT_NAME deploy
  $SCRIPT_NAME --dry-run deploy
EOF
}

VERBOSE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)    usage; exit 0 ;;
    -v|--verbose) VERBOSE=true; shift ;;
    -n|--dry-run) DRY_RUN=true; shift ;;
    -*)           echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)            break ;;
  esac
done

if [[ $# -lt 1 ]]; then
  echo "Error: missing required argument" >&2
  usage >&2
  exit 1
fi
```

Key points:

- `SCRIPT_NAME` is always included (used by `usage()`)
- Add `SCRIPT_DIR` only when the script needs to reference files relative to its own location:
  ```bash
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ```
  Scripts that work from the caller's working directory (e.g., runbook-invoked scripts) don't need it.
- `--help` always works, always exits 0
- Unknown flags fail loudly with usage hint
- Missing required args fail with specific error
- Errors go to stderr (`>&2`)

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | User error (bad args, missing input) |
| 2 | Missing dependency |

Consistent exit codes let scripts compose in pipelines and CI.

### Dependency Checks

Check required tools upfront before doing any work:

```bash
command -v node >/dev/null || { echo "node required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
```

### Output

- If the script references sibling files, use `SCRIPT_DIR` for relative paths so it works from any working directory
- Only use colored output when interactive: `[[ -t 1 ]]` before ANSI codes
- Provide `--dry-run` for destructive operations so users can preview before committing

## Project Conventions

### Location

Put scripts in `scripts/` at the repo root with a clear naming convention:

```
scripts/
  build-runbooks.sh
  check-deps.sh
  setup-dev.ts
```

### Discoverability

Wire scripts through `package.json` so they're findable via `npm run`:

```json
{
  "scripts": {
    "check-deps": "./scripts/check-deps.sh"
  }
}
```

### Documentation

Include a top-level comment describing intent. Someone reading the file should understand what it does in 3 lines, independent of `--help` output.

```bash
#!/usr/bin/env bash
# Validates that all required development dependencies are installed
# and at compatible versions. Run after cloning or updating the repo.
set -euo pipefail
```

### TypeScript Scripts

For anything beyond simple glue, use a `.ts` script:

```bash
npx tsx scripts/thing.ts
```

You get type safety, access to project dependencies, and cross-platform support.
