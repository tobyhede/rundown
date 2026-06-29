import { describe, it, expect } from '@jest/globals';
import type { Option } from 'commander';
import { GLOBAL_VALUE_TAKING_OPTION_NAMES } from '@rundown-org/core';
import { createProgram } from '../../src/cli.js';

// Single-source-of-truth invariant for the PROGRAM-LEVEL (global) value-taking
// option surface.
//
// The rundown CLI accepts global options BEFORE the subcommand (e.g.
// `rundown --policy foo.json pass`). The subprocess trust boundary
// (`@rundown-org/core` subprocess-mutation-boundary) locates the real command
// token by skipping leading globals, and a VALUE-TAKING global also consumes the
// following token (`--policy <file>`). If the CLI grows a new value-taking global
// (e.g. `--audit-log <path>`) without the boundary learning it consumes a value,
// the command-token scan misreads that value as the command and a bare `pass`
// behind it launders direct-CLI trust past the gate (fail open). The boundary set
// `GLOBAL_VALUE_TAKING_OPTION_NAMES` is therefore the single source of truth; the
// CLI program registration must not introduce a value-taking global the boundary
// does not know about. This test pins that they cannot drift: a value-taking
// program option absent from the core list (or vice versa) fails the build —
// fail-closed on drift. Boolean globals are intentionally NOT pinned: both they
// and unrecognized leading flags consume no following token, so the scan treats
// them identically (skip one) and only value-arity is security-relevant.

/** Long names of the value-taking options registered at program scope. */
function registeredValueTakingProgramOptionLongs(): string[] {
  const program = createProgram();
  return program.options
    .filter((option: Option) => option.required || option.optional)
    .map((option: Option) => option.long)
    .filter((long): long is string => long !== undefined)
    .sort();
}

describe('program-level value-taking option single source of truth', () => {
  it('registers exactly the boundary-known value-taking global options', () => {
    const expected = [...GLOBAL_VALUE_TAKING_OPTION_NAMES].sort();
    expect(registeredValueTakingProgramOptionLongs()).toEqual(expected);
  });
});
