# CLI `--var` → `--input` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all `--var`/`--var-json`/`--var-file`/`RD_VAR_*` CLI flags and their internal TypeScript identifiers to `--input`/`--input-json`/`--input-file`/`RD_INPUT_*`.

**Architecture:** Pure mechanical rename — no logic changes. Foundation types (`VarOptions`, `ENV_VAR_PREFIX`, `parseVarOption`, `extractVarFileReferences`) are renamed first; their consumers (CLI commands, tests, docs) follow in the next wave.

**Tech Stack:** TypeScript, Commander.js, Jest, Markdown

---

## Parallelism Guide

```
Wave 1 (Tasks 1–4 run in parallel):
  Task 1  variable-discovery.ts
  Task 2  runbook-pipeline.ts
  Task 3  option-utils.ts
  Task 4  command-sequence.ts

Wave 2 (Tasks 5–8 run in parallel, after Wave 1):
  Task 5  CLI commands (run / claim / delegate / resolve)
  Task 6  scenario-workflow.ts
  Task 7  delegation-dispatch.ts
  Task 8  core/parser comments

Task 9 (after Wave 2): Tests
Task 10 (fully independent, can run any time): Documentation
Task 11 (last): Build verification
```

---

## File Map

**Modified — Wave 1**
- `packages/cli/src/services/variable-discovery.ts` — `ENV_VAR_PREFIX`, `collectEnvBridgeVars`, `collectCliFlags` param type, `collectRawLayers` param type, `resolveVariables` param type, JSDoc/error messages
- `packages/cli/src/helpers/runbook-pipeline.ts` — `VarOptions` interface → `InputOptions`, property names, error message
- `packages/cli/src/helpers/option-utils.ts` — `parseVarOption` → `parseInputOption`, `parseVarJsonOption` → `parseInputJsonOption`, error strings
- `packages/cli/src/helpers/command-sequence.ts` — `extractVarFileReferences` → `extractInputFileReferences`, `'--var-file'` literal

**Modified — Wave 2**
- `packages/cli/src/commands/run.ts` — option definitions, inline options type, `varOpts` → `inputOpts`
- `packages/cli/src/commands/claim.ts` — option definitions, inline options type, `varOpts` → `inputOpts`
- `packages/cli/src/commands/delegate.ts` — option definitions, inline options type
- `packages/cli/src/commands/resolve.ts` — `ResolveOptions` interface, option definitions
- `packages/cli/src/helpers/scenario-workflow.ts` — import + usage of `extractVarFileReferences` → `extractInputFileReferences`
- `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts` — `'--var '` string literal → `'--input '`
- `packages/core/src/runbook/types.ts` — JSDoc comments only
- `packages/parser/src/reserved.ts` — JSDoc comments only

**Modified — Tests (Tasks 7 & 9)**
- `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts` — Task 7
- `packages/cli/__tests__/helpers/option-utils.test.ts`
- `packages/cli/__tests__/services/variable-discovery.test.ts`
- `packages/cli/__tests__/commands/run-variables.test.ts`
- `packages/cli/__tests__/commands/resolve.test.ts`
- `packages/cli/__tests__/commands/claim.test.ts`
- `packages/cli/__tests__/commands/delegate.test.ts`
- `packages/cli/__tests__/helpers/runbook-pipeline.test.ts`
- `packages/cli/__tests__/helpers/scenario-workflow.test.ts`
- `packages/cli/__tests__/integration/template-variables.test.ts`
- `packages/cli/__tests__/integration/delegation-claim.test.ts`
- `packages/cli/__tests__/integration/for-loop-variables.test.ts`
- `packages/cli/__tests__/integration/for-loop-data-sources.test.ts`
- `packages/cli/__tests__/integration/frontmatter-outputs.test.ts`
- `packages/cli/__tests__/integration/context-passing-substep.test.ts`
- `packages/cli/__tests__/integration/scenario-runner.test.ts`
- `packages/cli/__tests__/integration/inline-linkage.test.ts`

**Modified — Documentation (Task 10)**
- `CLAUDE.md`, `README.md`
- `docs/SPEC.md`, `docs/RUNDOWN.md`, `docs/FORMAT.md`, `docs/SECURITY.md`, `docs/MCP.md`, `docs/PROJECT-INTEGRATION.md`, `docs/AGENT-ORCHESTRATION.md`
- `runbooks/README.md`
- `runbooks/variables/*.runbook.md` (4 files)
- `runbooks/for-loops/*.runbook.md` (7 files)
- `runbooks/delegation/*.runbook.md` (3 files)
- `runbooks/context-passing/outputs-inputs.runbook.md`
- `packages/claude-code-plugin/skills/running-runbooks/SKILL.md`
- `packages/claude-code-plugin/skills/writing-runbooks/SKILL.md`
- `packages/claude-code-plugin/skills/delegating-runbooks/SKILL.md`

---

## Task 1: Rename core variable-discovery service

**Files:**
- Modify: `packages/cli/src/services/variable-discovery.ts`

- [ ] **Step 1: Rename ENV_VAR_PREFIX constant and its JSDoc**

  Find (line ~634):
  ```typescript
  /**
   * Environment variable prefix for the variable bridge.
   * Variables matching `RD_VAR_<name>` are mapped to template variable `<name>`.
   */
  const ENV_VAR_PREFIX = 'RD_VAR_';
  ```

  Replace with:
  ```typescript
  /**
   * Environment variable prefix for the variable bridge.
   * Variables matching `RD_INPUT_<name>` are mapped to template variable `<name>`.
   */
  const ENV_INPUT_PREFIX = 'RD_INPUT_';
  ```

- [ ] **Step 2: Update collectEnvBridgeVars to use ENV_INPUT_PREFIX**

  Find (line ~647):
  ```typescript
  function collectEnvBridgeVars(warnings?: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [envKey, value] of Object.entries(process.env)) {
      if (envKey.startsWith(ENV_VAR_PREFIX) && value !== undefined) {
        const varName = envKey.slice(ENV_VAR_PREFIX.length);
  ```

  Replace with:
  ```typescript
  function collectEnvBridgeVars(warnings?: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [envKey, value] of Object.entries(process.env)) {
      if (envKey.startsWith(ENV_INPUT_PREFIX) && value !== undefined) {
        const varName = envKey.slice(ENV_INPUT_PREFIX.length);
  ```

- [ ] **Step 3: Update collectEnvBridgeVars JSDoc comment**

  Find (line ~639):
  ```typescript
  /**
   * Collect variables from environment using the RD_VAR_* prefix convention.
   *
   * Environment variables matching RD_VAR_<name> are mapped to variable <name>.
   * Variable names are validated against the identifier pattern.
   *
   * @param warnings - Optional array to collect discovery warnings
   * @returns Collected environment bridge variables
   */
  ```

  Replace with:
  ```typescript
  /**
   * Collect variables from environment using the RD_INPUT_* prefix convention.
   *
   * Environment variables matching RD_INPUT_<name> are mapped to variable <name>.
   * Variable names are validated against the identifier pattern.
   *
   * @param warnings - Optional array to collect discovery warnings
   * @returns Collected environment bridge variables
   */
  ```

- [ ] **Step 4: Update collectCliFlags JSDoc and parameter type**

  Find (line ~323):
  ```typescript
   * @param options.varFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.var - Array of key=value flag strings from CLI
   * @param options.varJson - Array of key=json flag strings from CLI for structured values
   * @param cwd - Current working directory for resolving relative var-file paths
   * @returns Merged variable record with raw types preserved
   */
  export async function collectCliFlags(
    options: { varFile?: string[]; var?: string[]; varJson?: string[] },
  ```

  Replace with:
  ```typescript
   * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.input - Array of key=value flag strings from CLI
   * @param options.inputJson - Array of key=json flag strings from CLI for structured values
   * @param cwd - Current working directory for resolving relative input-file paths
   * @returns Merged variable record with raw types preserved
   */
  export async function collectCliFlags(
    options: { inputFile?: string[]; input?: string[]; inputJson?: string[] },
  ```

- [ ] **Step 5: Update collectCliFlags body to use new property names**

  Find (line ~337):
  ```typescript
    // var-file(s) — repeatable, later overrides earlier
    for (const vf of options.varFile ?? []) {
  ```
  Replace with:
  ```typescript
    // input-file(s) — repeatable, later overrides earlier
    for (const vf of options.inputFile ?? []) {
  ```

  Find (line ~347):
  ```typescript
    // --var flags
    if (options.var) {
      for (const flag of options.var) {
        const parsed = parseVarFlag(flag);
        if (!parsed) {
          throw new Error(
            `Unexpected invalid --var entry: ${flag} (parseVarOption should have rejected this)`,
          );
        }
  ```
  Replace with:
  ```typescript
    // --input flags
    if (options.input) {
      for (const flag of options.input) {
        const parsed = parseVarFlag(flag);
        if (!parsed) {
          throw new Error(
            `Unexpected invalid --input entry: ${flag} (parseInputOption should have rejected this)`,
          );
        }
  ```

  Find (line ~360):
  ```typescript
    // --var-json values (processed after --var, so wins for same key)
    if (options.varJson) {
      for (const flag of options.varJson) {
  ```
  Replace with:
  ```typescript
    // --input-json values (processed after --input, so wins for same key)
    if (options.inputJson) {
      for (const flag of options.inputJson) {
  ```

  Also update the inner error message in that block:
  Find:
  ```typescript
          throw new Error(
            `Unexpected invalid --var-json key: ${key} (parseVarJsonOption should have rejected this)`,
          );
  ```
  Replace with:
  ```typescript
          throw new Error(
            `Unexpected invalid --input-json key: ${key} (parseInputJsonOption should have rejected this)`,
          );
  ```

- [ ] **Step 6: Update collectRawLayers JSDoc and parameter type**

  Find (line ~685):
  ```typescript
   * @param options.varFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.var - Array of key=value flag strings from CLI
   * @param options.varJson - Array of key=json flag strings from CLI for structured values
  ```
  Replace with:
  ```typescript
   * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.input - Array of key=value flag strings from CLI
   * @param options.inputJson - Array of key=json flag strings from CLI for structured values
  ```

  Find (line ~694):
  ```typescript
  async function collectRawLayers(
    options: {
      varFile?: string[];
      var?: string[];
      varJson?: string[];
  ```
  Replace with:
  ```typescript
  async function collectRawLayers(
    options: {
      inputFile?: string[];
      input?: string[];
      inputJson?: string[];
  ```

  Find the comment in the function body (line ~720):
  ```typescript
    // Layer 4: Environment bridge (RD_VAR_* env vars)
  ```
  Replace with:
  ```typescript
    // Layer 4: Environment bridge (RD_INPUT_* env vars)
  ```

  Find (line ~720):
  ```typescript
    // Layer 5: CLI flags (--var-file, --var, --var-json merged)
  ```
  Replace with:
  ```typescript
    // Layer 5: CLI flags (--input-file, --input, --input-json merged)
  ```

- [ ] **Step 7: Update resolveVariables JSDoc and parameter type**

  Find (line ~805):
  ```typescript
  export async function resolveVariables(
    options: {
      varFile?: string[];
      var?: string[];
      varJson?: string[];
  ```
  Replace with:
  ```typescript
  export async function resolveVariables(
    options: {
      inputFile?: string[];
      input?: string[];
      inputJson?: string[];
  ```

  Find the JSDoc params above it (line ~806):
  ```typescript
   * @param options.varFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.var - Array of key=value flag strings from CLI
   * @param options.varJson - Array of key=json flag strings from CLI for structured values
  ```
  Replace with:
  ```typescript
   * @param options.inputFile - Array of paths to YAML files containing variable definitions (repeatable)
   * @param options.input - Array of key=value flag strings from CLI
   * @param options.inputJson - Array of key=json flag strings from CLI for structured values
  ```

- [ ] **Step 8: Commit**

  ```bash
  git add packages/cli/src/services/variable-discovery.ts
  git commit -m "refactor: rename ENV_VAR_PREFIX → ENV_INPUT_PREFIX and update RD_VAR_* to RD_INPUT_* in variable-discovery"
  ```

---

## Task 2: Rename pipeline interface

**Files:**
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts`

- [ ] **Step 1: Rename VarOptions interface and its properties**

  Find (line ~68):
  ```typescript
  /**
   * Variable options from CLI flags.
   */
  export interface VarOptions {
    /** Paths to YAML files containing variable definitions (repeatable) */
    varFile?: string[];
    /** Inline key=value variable overrides (repeatable) */
    var?: string[];
    /** Inline key=json variable overrides with JSON values (repeatable) */
    varJson?: string[];
  }
  ```

  Replace with:
  ```typescript
  /**
   * Input options from CLI flags.
   */
  export interface InputOptions {
    /** Paths to YAML files containing variable definitions (repeatable) */
    inputFile?: string[];
    /** Inline key=value variable overrides (repeatable) */
    input?: string[];
    /** Inline key=json variable overrides with JSON values (repeatable) */
    inputJson?: string[];
  }
  ```

- [ ] **Step 2: Rename VarOptions → InputOptions at all usage sites in the file**

  There are two function signatures that reference `VarOptions`. Run:
  ```bash
  grep -n "VarOptions\|varOpts" packages/cli/src/helpers/runbook-pipeline.ts
  ```

  For each occurrence of `varOpts: VarOptions`, rename to `inputOpts: InputOptions`.
  For each occurrence of `varOpts` as a local variable name, rename to `inputOpts`.

  The two function signatures are around line 419 and 817:
  - `prepareRunbook(file: string, varOpts: VarOptions, ...)` → `prepareRunbook(file: string, inputOpts: InputOptions, ...)`
  - Second internal function using `varOpts: VarOptions` → `inputOpts: InputOptions`

  Update all references to `varOpts` inside those function bodies to `inputOpts`.

- [ ] **Step 3: Update the error message at line ~542**

  Find:
  ```typescript
        error: `Missing required variable${missing.length > 1 ? 's' : ''}: ${names}. Provide via --var, --var-file, config.yaml, RD_VAR_* environment variable, or prior runbook OUTPUTS.`,
  ```
  Replace with:
  ```typescript
        error: `Missing required variable${missing.length > 1 ? 's' : ''}: ${names}. Provide via --input, --input-file, config.yaml, RD_INPUT_* environment variable, or prior runbook OUTPUTS.`,
  ```

- [ ] **Step 4: Update any comments in the file referencing --var, RD_VAR_***

  Find (line ~531):
  ```typescript
  // Loads outputs published under the **resolved** ContextId (so child
  // overrides via `claim --var ContextId=...` are respected)
  ```
  Replace with:
  ```typescript
  // Loads outputs published under the **resolved** ContextId (so child
  // overrides via `claim --input ContextId=...` are respected)
  ```

  Find the layer comment (line ~678):
  ```typescript
    // Layer 5: cliFlags        ← --var-file, --var, --var-json (highest precedence)
  ```
  Replace with:
  ```typescript
    // Layer 5: cliFlags        ← --input-file, --input, --input-json (highest precedence)
  ```

  Also update the related layer 4 comment:
  ```
  // Layer 4: envBridge        ← RD_VAR_* environment variables
  ```
  Replace with:
  ```
  // Layer 4: envBridge        ← RD_INPUT_* environment variables
  ```

- [ ] **Step 5: Verify the file compiles**

  ```bash
  cd packages/cli && npx tsc --noEmit 2>&1 | grep runbook-pipeline
  ```
  Expected: no errors for this file.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/cli/src/helpers/runbook-pipeline.ts
  git commit -m "refactor: rename VarOptions → InputOptions and varOpts → inputOpts in runbook-pipeline"
  ```

---

## Task 3: Rename option utilities

**Files:**
- Modify: `packages/cli/src/helpers/option-utils.ts`

- [ ] **Step 1: Rename parseVarOption → parseInputOption**

  Find the JSDoc (line ~29):
  ```typescript
  /**
   * Commander argParser for --var that validates at parse time.
   *
   * Supports two forms:
   * - `key=value`: validates identifier and accumulates
   * - `KEY` (no =): inherits value from process.env[KEY]
   *
   * @param value - The raw flag value
   * @param previous - Previously accumulated values
   * @returns Updated array with new key=value entry
   * @throws {InvalidArgumentError} When identifier is invalid or env var not set
   */
  export function parseVarOption(value: string, previous: string[]): string[] {
  ```

  Replace with:
  ```typescript
  /**
   * Commander argParser for --input that validates at parse time.
   *
   * Supports two forms:
   * - `key=value`: validates identifier and accumulates
   * - `KEY` (no =): inherits value from process.env[KEY]
   *
   * @param value - The raw flag value
   * @param previous - Previously accumulated values
   * @returns Updated array with new key=value entry
   * @throws {InvalidArgumentError} When identifier is invalid or env var not set
   */
  export function parseInputOption(value: string, previous: string[]): string[] {
  ```

- [ ] **Step 2: Update error message inside parseInputOption that references --var**

  Find (line ~63):
  ```typescript
      throw new InvalidArgumentError(
        `Environment variable "${value}" is not set (use --var ${value}=<value>)`,
      );
  ```
  Replace with:
  ```typescript
      throw new InvalidArgumentError(
        `Environment variable "${value}" is not set (use --input ${value}=<value>)`,
      );
  ```

- [ ] **Step 3: Rename parseVarJsonOption → parseInputJsonOption**

  Find the JSDoc (line ~69):
  ```typescript
  /**
   * Commander argParser for --var-json that validates JSON at parse time.
   *
   * @param value - The raw flag value in key=json format
   * @param previous - Previously accumulated values
   * @returns Updated array with new key=json entry
   * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
   */
  export function parseVarJsonOption(value: string, previous: string[]): string[] {
  ```

  Replace with:
  ```typescript
  /**
   * Commander argParser for --input-json that validates JSON at parse time.
   *
   * @param value - The raw flag value in key=json format
   * @param previous - Previously accumulated values
   * @returns Updated array with new key=json entry
   * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
   */
  export function parseInputJsonOption(value: string, previous: string[]): string[] {
  ```

- [ ] **Step 4: Verify full file content**

  The complete updated `option-utils.ts` should export:
  - `collect` (unchanged)
  - `parseInputOption` (was `parseVarOption`)
  - `parseInputJsonOption` (was `parseVarJsonOption`)

  Run:
  ```bash
  grep -n "export function" packages/cli/src/helpers/option-utils.ts
  ```
  Expected output:
  ```
  25:export function collect(value: string, previous: string[]): string[] {
  41:export function parseInputOption(value: string, previous: string[]): string[] {
  77:export function parseInputJsonOption(value: string, previous: string[]): string[] {
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add packages/cli/src/helpers/option-utils.ts
  git commit -m "refactor: rename parseVarOption → parseInputOption and parseVarJsonOption → parseInputJsonOption"
  ```

---

## Task 4: Rename command-sequence helper

**Files:**
- Modify: `packages/cli/src/helpers/command-sequence.ts`

- [ ] **Step 1: Rename extractVarFileReferences → extractInputFileReferences**

  Find the JSDoc (line ~375):
  ```typescript
   * @param commands - Array of command strings to scan
   * @returns Array of unique relative file paths found in --var-file arguments
   */
  export function extractVarFileReferences(commands: string[]): string[] {
  ```

  Replace with:
  ```typescript
   * @param commands - Array of command strings to scan
   * @returns Array of unique relative file paths found in --input-file arguments
   */
  export function extractInputFileReferences(commands: string[]): string[] {
  ```

- [ ] **Step 2: Update the '--var-file' string literal inside the function body**

  Find (line ~392):
  ```typescript
        if (args[i] === '--var-file' && i + 1 < args.length) {
  ```
  Replace with:
  ```typescript
        if (args[i] === '--input-file' && i + 1 < args.length) {
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add packages/cli/src/helpers/command-sequence.ts
  git commit -m "refactor: rename extractVarFileReferences → extractInputFileReferences and --var-file → --input-file string literal"
  ```

---

## Task 5: Update CLI commands

> **Depends on:** Tasks 1, 2, 3 complete

**Files:**
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/src/commands/resolve.ts`

### 5a — run.ts

- [ ] **Step 1: Update imports to use renamed exports**

  Find the import of `parseVarOption`, `parseVarJsonOption`:
  ```typescript
  import { collect, parseVarOption, parseVarJsonOption } from '../helpers/option-utils.js';
  ```
  Replace with:
  ```typescript
  import { collect, parseInputOption, parseInputJsonOption } from '../helpers/option-utils.js';
  ```

- [ ] **Step 2: Update option definitions**

  Find:
  ```typescript
      .addOption(
        new Option('--var-file <path>', 'Load variables from YAML file (repeatable)')
          .argParser(collect)
          .default([])
          .helpGroup('Variable options:'),
      )
      .addOption(
        new Option('--var <key=value>', 'Set variable (repeatable, omit =value to inherit from env)')
          .argParser(parseVarOption)
          .default([])
          .helpGroup('Variable options:'),
      )
      .addOption(
        new Option('--var-json <key=json>', 'Set variable with JSON value (repeatable)')
          .argParser(parseVarJsonOption)
          .default([])
          .helpGroup('Variable options:'),
      )
  ```

  Replace with:
  ```typescript
      .addOption(
        new Option('--input-file <path>', 'Load inputs from YAML file (repeatable)')
          .argParser(collect)
          .default([])
          .helpGroup('Input options:'),
      )
      .addOption(
        new Option('--input <key=value>', 'Set input (repeatable, omit =value to inherit from env)')
          .argParser(parseInputOption)
          .default([])
          .helpGroup('Input options:'),
      )
      .addOption(
        new Option('--input-json <key=json>', 'Set input with JSON value (repeatable)')
          .argParser(parseInputJsonOption)
          .default([])
          .helpGroup('Input options:'),
      )
  ```

- [ ] **Step 3: Update the action handler inline options type**

  Find:
  ```typescript
        options: {
          prompted?: boolean;
          step?: string;
          index?: string;
          text?: boolean;
          varFile?: string[];
          var?: string[];
          varJson?: string[];
        },
  ```
  Replace with:
  ```typescript
        options: {
          prompted?: boolean;
          step?: string;
          index?: string;
          text?: boolean;
          inputFile?: string[];
          input?: string[];
          inputJson?: string[];
        },
  ```

- [ ] **Step 4: Rename varOpts assignment**

  Find (line ~115):
  ```typescript
          const varOpts = { varFile: options.varFile, var: options.var, varJson: options.varJson };
  ```
  Replace with:
  ```typescript
          const inputOpts = { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson };
  ```

- [ ] **Step 5: Update all usages of varOpts in run.ts**

  Find all occurrences of `varOpts` in the file and replace with `inputOpts`. Run:
  ```bash
  grep -n "varOpts" packages/cli/src/commands/run.ts
  ```
  Replace each occurrence: `varOpts` → `inputOpts`.

### 5b — claim.ts

- [ ] **Step 6: Update imports**

  Find:
  ```typescript
  import { collect, parseVarOption, parseVarJsonOption } from '../helpers/option-utils.js';
  ```
  Replace with:
  ```typescript
  import { collect, parseInputOption, parseInputJsonOption } from '../helpers/option-utils.js';
  ```

- [ ] **Step 7: Update option definitions**

  Apply the same option definition replacement as run.ts (Step 2 above):
  - `--var-file` → `--input-file`, help text, helpGroup `'Variable options:'` → `'Input options:'`
  - `--var` → `--input`, `parseVarOption` → `parseInputOption`
  - `--var-json` → `--input-json`, `parseVarJsonOption` → `parseInputJsonOption`

- [ ] **Step 8: Update action handler options type**

  Find:
  ```typescript
          options: {
            text?: boolean;
            varFile?: string[];
            var?: string[];
            varJson?: string[];
          },
  ```
  Replace with:
  ```typescript
          options: {
            text?: boolean;
            inputFile?: string[];
            input?: string[];
            inputJson?: string[];
          },
  ```

- [ ] **Step 9: Rename varOpts in claim.ts**

  Find (line ~75):
  ```typescript
            const varOpts = {
              varFile: options.varFile,
              var: options.var,
              varJson: options.varJson,
            };
            const result = await claimAndLaunch(ctx, token, varOpts);
  ```
  Replace with:
  ```typescript
            const inputOpts = {
              inputFile: options.inputFile,
              input: options.input,
              inputJson: options.inputJson,
            };
            const result = await claimAndLaunch(ctx, token, inputOpts);
  ```

### 5c — delegate.ts

- [ ] **Step 10: Update imports in delegate.ts**

  Find:
  ```typescript
  import { collect, parseVarOption, parseVarJsonOption } from '../helpers/option-utils.js';
  ```
  Replace with:
  ```typescript
  import { collect, parseInputOption, parseInputJsonOption } from '../helpers/option-utils.js';
  ```

- [ ] **Step 11: Update option definitions in delegate.ts**

  Apply the same option definition replacement as run.ts. Note: in delegate.ts the order of option registration differs (var, var-json, var-file). Update all three to their `--input`/`--input-json`/`--input-file` equivalents, using `parseInputOption`/`parseInputJsonOption`/`collect`, and change helpGroup to `'Input options:'`.

- [ ] **Step 12: Update action handler options type in delegate.ts**

  Find:
  ```typescript
          options: {
            step?: string;
            index?: string;
            var: string[];
            varJson?: string[];
            varFile?: string[];
            text?: boolean;
          },
  ```
  Replace with:
  ```typescript
          options: {
            step?: string;
            index?: string;
            input: string[];
            inputJson?: string[];
            inputFile?: string[];
            text?: boolean;
          },
  ```

- [ ] **Step 13: Update collectCliFlags call in delegate.ts**

  Find (line ~132):
  ```typescript
            const rawVars = await collectCliFlags(
              { varFile: options.varFile, var: options.var, varJson: options.varJson },
              cwd,
  ```
  Replace with:
  ```typescript
            const rawVars = await collectCliFlags(
              { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
              cwd,
  ```

### 5d — resolve.ts

- [ ] **Step 14: Update imports in resolve.ts**

  Find:
  ```typescript
  import { collect, parseVarOption, parseVarJsonOption } from '../helpers/option-utils.js';
  ```
  Replace with:
  ```typescript
  import { collect, parseInputOption, parseInputJsonOption } from '../helpers/option-utils.js';
  ```

- [ ] **Step 15: Rename ResolveOptions interface properties**

  Find (line ~51):
  ```typescript
  interface ResolveOptions {
    /** Paths to YAML variable files (repeatable) */
    varFile?: string[];
    /** CLI variable assignments (key=value) */
    var?: string[];
    /** CLI variable assignments with JSON values (key=json) */
    varJson?: string[];
    /** Output as human-readable text instead of JSON */
    text?: boolean;
  }
  ```

  Replace with:
  ```typescript
  interface ResolveOptions {
    /** Paths to YAML input files (repeatable) */
    inputFile?: string[];
    /** CLI input assignments (key=value) */
    input?: string[];
    /** CLI input assignments with JSON values (key=json) */
    inputJson?: string[];
    /** Output as human-readable text instead of JSON */
    text?: boolean;
  }
  ```

- [ ] **Step 16: Update option definitions in resolve.ts**

  Apply the same option definition replacement as run.ts.

- [ ] **Step 17: Update prepareRunbook call in resolve.ts**

  Find (line ~94):
  ```typescript
        const result = await prepareRunbook(
          file,
          { varFile: options.varFile, var: options.var, varJson: options.varJson },
          cwd,
        );
  ```
  Replace with:
  ```typescript
        const result = await prepareRunbook(
          file,
          { inputFile: options.inputFile, input: options.input, inputJson: options.inputJson },
          cwd,
        );
  ```

- [ ] **Step 18: Verify all four command files compile**

  ```bash
  cd packages/cli && npx tsc --noEmit 2>&1 | grep -E "commands/(run|claim|delegate|resolve)"
  ```
  Expected: no errors.

- [ ] **Step 19: Commit**

  ```bash
  git add packages/cli/src/commands/run.ts packages/cli/src/commands/claim.ts \
          packages/cli/src/commands/delegate.ts packages/cli/src/commands/resolve.ts
  git commit -m "refactor: rename --var/--var-json/--var-file to --input/--input-json/--input-file in CLI commands"
  ```

---

## Task 6: Update scenario-workflow.ts

> **Depends on:** Task 4 complete

**Files:**
- Modify: `packages/cli/src/helpers/scenario-workflow.ts`

- [ ] **Step 1: Update the import of extractVarFileReferences**

  Find (line ~28):
  ```typescript
    extractVarFileReferences,
  ```
  Replace with:
  ```typescript
    extractInputFileReferences,
  ```

- [ ] **Step 2: Update usage at line ~233**

  Find (line ~230):
  ```typescript
      // Copy --var-file data files and their sibling directory contents.
      // Var files may contain file: references to sibling data files (e.g. JSONL),
      // so copy the entire containing directory to preserve those references.
      const varFiles = extractVarFileReferences(scenario.commands);
      const copiedDirs = new Set<string>();
      for (const varFile of varFiles) {
        const varDir = dirname(varFile);
  ```
  Replace with:
  ```typescript
      // Copy --input-file data files and their sibling directory contents.
      // Input files may contain file: references to sibling data files (e.g. JSONL),
      // so copy the entire containing directory to preserve those references.
      const inputFiles = extractInputFileReferences(scenario.commands);
      const copiedDirs = new Set<string>();
      for (const inputFile of inputFiles) {
        const varDir = dirname(inputFile);
  ```

  Also update the remaining `varFile` local variable usages in that loop body. Find:
  ```typescript
          throw new Error(`Var file directory not found: ${varDir} (searched in: ${sourceDir})`);
  ```
  Replace with:
  ```typescript
          throw new Error(`Input file directory not found: ${varDir} (searched in: ${sourceDir})`);
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add packages/cli/src/helpers/scenario-workflow.ts
  git commit -m "refactor: update scenario-workflow to use extractInputFileReferences"
  ```

---

## Task 7: Update delegation-dispatch.ts and its tests

> **No dependencies — can run at any time**

**Files:**
- Modify: `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts`
- Modify: `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts`

- [ ] **Step 1: Update JSDoc comments referencing --var**

  Find (line ~23):
  ```typescript
  /**
   * Shell-safe quote a string value for use in a `--var key=value` flag.
  ```
  Replace with:
  ```typescript
  /**
   * Shell-safe quote a string value for use in a `--input key=value` flag.
  ```

  Find (line ~56):
  ```typescript
  /**
   * Build `--var key=value` flags for a child runbook from parent's live variable space.
   *
   * Reads the child runbook's frontmatter `inputs:` keys and, for each key that
   * exists in the parent's vars, produces a `--var key=value` flag. Non-fatal:
   * returns empty string on any error.
   *
   * @param childRunbookPath - Absolute or cwd-relative path to the child runbook
   * @param parentVars - Parent's live variable space from `rd status --json`
   * @param cwd - Current working directory for resolving relative paths
   * @returns Space-separated `--var` flags string, or empty string
   */
  ```
  Replace with:
  ```typescript
  /**
   * Build `--input key=value` flags for a child runbook from parent's live variable space.
   *
   * Reads the child runbook's frontmatter `inputs:` keys and, for each key that
   * exists in the parent's vars, produces a `--input key=value` flag. Non-fatal:
   * returns empty string on any error.
   *
   * @param childRunbookPath - Absolute or cwd-relative path to the child runbook
   * @param parentVars - Parent's live variable space from `rd status --json`
   * @param cwd - Current working directory for resolving relative paths
   * @returns Space-separated `--input` flags string, or empty string
   */
  ```

- [ ] **Step 2: Rename buildChildVarFlags → buildChildInputFlags**

  Find (line ~68):
  ```typescript
  async function buildChildVarFlags(
  ```
  Replace with:
  ```typescript
  async function buildChildInputFlags(
  ```

  Then find the call site (line ~91 or wherever `buildChildVarFlags` is called in the file):
  ```bash
  grep -n "buildChildVarFlags" packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts
  ```
  Update each call site from `buildChildVarFlags(` to `buildChildInputFlags(`.

- [ ] **Step 3: Update the --var string literal in the function body**

  Find (line ~86):
  ```typescript
        .map((key) => `--var ${key}=${shellQuote(parentVars[key])}`)
  ```
  Replace with:
  ```typescript
        .map((key) => `--input ${key}=${shellQuote(parentVars[key])}`)
  ```

- [ ] **Step 4: Update inline comments referencing --var flags**

  Find (line ~129):
  ```typescript
    // Best-effort: enrich with current delegation status and inject child --var flags
  ```
  Replace with:
  ```typescript
    // Best-effort: enrich with current delegation status and inject child --input flags
  ```

  Find (line ~143):
  ```typescript
    // Inject --var flags from child runbook's inputs: keys using parent's live vars.
  ```
  Replace with:
  ```typescript
    // Inject --input flags from child runbook's inputs: keys using parent's live vars.
  ```

- [ ] **Step 5: Update delegation-dispatch.test.ts assertions**

  The test file asserts on the generated command string. Replace all `--var` literals in assertion strings:

  ```bash
  grep -n '"--var\|'\''--var\|`--var' packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts
  ```

  Expected matches (update each):
  - `"--var PlanPath='/work/plan.json'"` → `"--input PlanPath='/work/plan.json'"`
  - `"--var environment='production'"` → `"--input environment='production'"`
  - `'--var'` in `.not.toContain('--var')` → `.not.toContain('--input')`  ← but keep this as `--input` only if the test is checking that no such flags appear
  - `"--var DollarVar='$HOME/data'"` → `"--input DollarVar='$HOME/data'"`
  - `"--var BacktickVar='\`whoami\`'"` → `"--input BacktickVar='\`whoami\`'"`
  - `"--var QuoteVar='it'\\''s fine'"` → `"--input QuoteVar='it'\\''s fine'"`
  - `"--var SpaceVar='has spaces'"` → `"--input SpaceVar='has spaces'"`

  Also update describe/it strings that reference `--var`:
  - `'injects --var flags for inputs declared'` → `'injects --input flags for inputs declared'`
  - `'shell-quotes --var values'` → `'shell-quotes --input values'`
  - `'does not inject --var flags'` → `'does not inject --input flags'`

- [ ] **Step 6: Run the plugin tests to verify**

  ```bash
  npx jest packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts --no-coverage
  ```
  Expected: all tests pass.

- [ ] **Step 7: Verify no remaining --var in delegation-dispatch source**

  ```bash
  grep -n "\-\-var" packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts
  ```
  Expected: zero matches.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts \
          packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts
  git commit -m "refactor: update delegation-dispatch to emit --input instead of --var, rename buildChildVarFlags"
  ```

---

## Task 8: Update core/parser JSDoc comments

> **No dependencies — can run at any time**

**Files:**
- Modify: `packages/core/src/runbook/types.ts`
- Modify: `packages/parser/src/reserved.ts`

- [ ] **Step 1: Find and update --var-json reference in types.ts**

  ```bash
  grep -n "\-\-var" packages/core/src/runbook/types.ts
  ```
  For each match, update `--var-json` → `--input-json`, `--var` → `--input` in JSDoc/comments only.

- [ ] **Step 2: Find and update --var reference in reserved.ts**

  ```bash
  grep -n "\-\-var" packages/parser/src/reserved.ts
  ```
  For each match, update `--var` → `--input` in JSDoc/comments only.

- [ ] **Step 3: Commit**

  ```bash
  git add packages/core/src/runbook/types.ts packages/parser/src/reserved.ts
  git commit -m "refactor: update JSDoc comments to reference --input instead of --var"
  ```

---

## Task 9: Update tests

> **Depends on:** All of Tasks 1–8 complete

**Test files to update — each can be updated independently in parallel if desired.**

The patterns to replace across all test files:
| Old | New |
|-----|-----|
| `parseVarOption` (import/call) | `parseInputOption` |
| `parseVarJsonOption` (import/call) | `parseInputJsonOption` |
| `extractVarFileReferences` (import/call) | `extractInputFileReferences` |
| `'--var-file'` in CLI invocation strings | `'--input-file'` |
| `'--var '` in CLI invocation strings | `'--input '` |
| `'--var-json '` in CLI invocation strings | `'--input-json '` |
| `RD_VAR_` in env var assignments/lookups | `RD_INPUT_` |
| `varFile:` property in option objects | `inputFile:` |
| `varJson:` property in option objects | `inputJson:` |
| `var:` property in option objects (when it is the CLI option, not a loop var) | `input:` |
| `parseVarOption` in describe/it strings | `parseInputOption` |
| `parseVarJsonOption` in describe/it strings | `parseInputJsonOption` |
| `--var` in describe/it strings | `--input` |

### packages/cli/__tests__/helpers/option-utils.test.ts

- [ ] **Step 1: Update import**

  Find:
  ```typescript
  import { collect, parseVarOption, parseVarJsonOption } from '../../src/helpers/option-utils.js';
  ```
  Replace with:
  ```typescript
  import { collect, parseInputOption, parseInputJsonOption } from '../../src/helpers/option-utils.js';
  ```

- [ ] **Step 2: Rename all parseVarOption calls and describe strings**

  Replace all occurrences in the file:
  - `parseVarOption` → `parseInputOption` (function calls and describe block names)
  - `parseVarJsonOption` → `parseInputJsonOption` (function calls and describe block names)
  - `--var ${...}` in error message assertion strings → `--input ${...}`
  - `--var-json` in describe/it strings → `--input-json`
  - `use --var ` in error message assertion → `use --input `

  Run:
  ```bash
  grep -n "parseVarOption\|parseVarJsonOption\|--var" packages/cli/__tests__/helpers/option-utils.test.ts
  ```
  Apply replacements for each match.

- [ ] **Step 3: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/helpers/option-utils.test.ts --no-coverage
  ```
  Expected: all tests pass.

### packages/cli/__tests__/services/variable-discovery.test.ts

- [ ] **Step 4: Replace RD_VAR_ with RD_INPUT_**

  ```bash
  grep -n "RD_VAR_\|varFile\|varJson\|var:" packages/cli/__tests__/services/variable-discovery.test.ts | head -20
  ```

  Apply these replacements throughout the file:
  - `RD_VAR_` → `RD_INPUT_` (all env var keys in test setup/assertions)
  - `varFile:` → `inputFile:` (in resolveVariables option objects)
  - `varJson:` → `inputJson:` (in resolveVariables option objects)
  - `var:` → `input:` (in resolveVariables option objects, only where it's the CLI option key)
  - `--var-file` → `--input-file` (in describe/it strings)
  - `--var` → `--input` (in describe/it strings)

  Note: do NOT rename `var` loop variables or `const varFile` local variables used for filesystem paths — those are unrelated locals.

- [ ] **Step 5: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/services/variable-discovery.test.ts --no-coverage
  ```
  Expected: all tests pass.

### packages/cli/__tests__/commands/run-variables.test.ts

- [ ] **Step 6: Update describe/it strings and CLI invocations**

  Find:
  ```typescript
  describe('rd run --var and --var-file', () => {
  ```
  Replace with:
  ```typescript
  describe('rd run --input and --input-file', () => {
  ```

  Then apply bulk replacements for all occurrences:
  - `--var-file` → `--input-file` (in CLI command strings passed to test runner)
  - `--var ` → `--input ` (in CLI command strings)
  - `--var-json` → `--input-json` (in CLI command strings)
  - `RD_VAR_` → `RD_INPUT_` (in `process.env` assignments)

- [ ] **Step 7: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/commands/run-variables.test.ts --no-coverage
  ```
  Expected: all tests pass.

### packages/cli/__tests__/commands/resolve.test.ts

- [ ] **Step 8: Update --var references in CLI invocation strings**

  ```bash
  grep -n "\-\-var\|varFile\|varJson" packages/cli/__tests__/commands/resolve.test.ts
  ```
  Apply replacements: `--var-file` → `--input-file`, `--var ` → `--input `, `--var-json` → `--input-json`.

- [ ] **Step 9: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/commands/resolve.test.ts --no-coverage
  ```

### packages/cli/__tests__/commands/claim.test.ts

- [ ] **Step 10: Update --var references in CLI invocation strings**

  ```bash
  grep -n "\-\-var\|varFile\|varJson" packages/cli/__tests__/commands/claim.test.ts
  ```
  Apply: `--var-file` → `--input-file`, `--var ` → `--input `, `--var-json` → `--input-json`.

- [ ] **Step 11: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/commands/claim.test.ts --no-coverage
  ```

### packages/cli/__tests__/commands/delegate.test.ts

- [ ] **Step 12: Update --var references**

  ```bash
  grep -n "\-\-var\|varFile\|varJson" packages/cli/__tests__/commands/delegate.test.ts
  ```
  Apply: `--var-file` → `--input-file`, `--var ` → `--input `, `--var-json` → `--input-json`.

- [ ] **Step 13: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/commands/delegate.test.ts --no-coverage
  ```

### packages/cli/__tests__/helpers/runbook-pipeline.test.ts

- [ ] **Step 14: Update error message assertions and --var references**

  ```bash
  grep -n "\-\-var\|varFile\|varJson\|RD_VAR_" packages/cli/__tests__/helpers/runbook-pipeline.test.ts
  ```
  Apply: `--var` → `--input`, `RD_VAR_` → `RD_INPUT_`, `varFile:` → `inputFile:`.

- [ ] **Step 15: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/helpers/runbook-pipeline.test.ts --no-coverage
  ```

### packages/cli/__tests__/helpers/scenario-workflow.test.ts

- [ ] **Step 16: Update extractVarFileReferences mock**

  Find (line ~49):
  ```typescript
    extractVarFileReferences: actualCommandSequence.extractVarFileReferences,
  ```
  Replace with:
  ```typescript
    extractInputFileReferences: actualCommandSequence.extractInputFileReferences,
  ```

- [ ] **Step 17: Update comment on line ~43**

  Find:
  ```typescript
  // Mock command-sequence (pass through extract helpers so extractReferencedRunbooks/var-file copying works)
  ```
  Replace with:
  ```typescript
  // Mock command-sequence (pass through extract helpers so extractReferencedRunbooks/input-file copying works)
  ```

- [ ] **Step 18: Verify tests pass**

  ```bash
  npx jest packages/cli/__tests__/helpers/scenario-workflow.test.ts --no-coverage
  ```

### Integration tests

- [ ] **Step 19: Update integration tests with --var in CLI invocations**

  For each of the following files, search and replace all `--var-file`, `--var `, `--var-json`, and `RD_VAR_` with their `--input` equivalents:

  ```bash
  for f in \
    packages/cli/__tests__/integration/template-variables.test.ts \
    packages/cli/__tests__/integration/delegation-claim.test.ts \
    packages/cli/__tests__/integration/for-loop-variables.test.ts \
    packages/cli/__tests__/integration/for-loop-data-sources.test.ts \
    packages/cli/__tests__/integration/frontmatter-outputs.test.ts \
    packages/cli/__tests__/integration/context-passing-substep.test.ts \
    packages/cli/__tests__/integration/scenario-runner.test.ts \
    packages/cli/__tests__/integration/inline-linkage.test.ts; do
    grep -l "\-\-var\|RD_VAR_\|varFile\|varJson" "$f" && echo "  needs update: $f"
  done
  ```

  For each matching file, apply:
  - `--var-file` → `--input-file`
  - `--var ` → `--input ` (note trailing space to avoid matching --var-file or --var-json)
  - `--var-json` → `--input-json`
  - `RD_VAR_` → `RD_INPUT_`
  - `varFile:` → `inputFile:` (in option object literals)
  - `varJson:` → `inputJson:` (in option object literals)
  - `var:` → `input:` (in option object literals, only the CLI option key)

- [ ] **Step 20: Run the full test suite for changed integration tests**

  ```bash
  npx jest packages/cli/__tests__/integration/ --no-coverage 2>&1 | tail -20
  ```
  Expected: all tests pass.

- [ ] **Step 21: Run all CLI unit tests**

  ```bash
  npm test --workspace=packages/cli 2>&1 | tail -20
  ```
  Expected: all tests pass.

- [ ] **Step 22: Commit**

  ```bash
  git add packages/cli/__tests__/
  git commit -m "refactor: update tests to use --input/RD_INPUT_*/inputFile/inputJson naming"
  ```

---

## Task 10: Update documentation

> **Independent — can run any time, in parallel with Tasks 1–9**

**Files to update** (apply `--var` → `--input`, `--var-json` → `--input-json`, `--var-file` → `--input-file`, `RD_VAR_` → `RD_INPUT_` throughout):

### CLAUDE.md

- [ ] **Step 1: Update CLAUDE.md command reference table and examples**

  ```bash
  grep -n "\-\-var\|RD_VAR_" CLAUDE.md
  ```

  Replace all occurrences in command tables and examples:
  - `rundown run [file] --var key=value` → `rundown run [file] --input key=value`
  - `rundown run [file] --var-json key=json` → `rundown run [file] --input-json key=json`
  - `rundown run [file] --var-file path` → `rundown run [file] --input-file path`
  - `rundown delegate <runbook> --step <id> --var key=value` → `rundown delegate <runbook> --step <id> --input key=value`
  - `rundown delegate <runbook> --step <id> --var-json key=json` → `rundown delegate <runbook> --step <id> --input-json key=json`
  - `rundown delegate <runbook> --step <id> --var-file path` → `rundown delegate <runbook> --step <id> --input-file path`
  - `rundown claim <token> --var key=value` → `rundown claim <token> --input key=value`
  - `rundown claim <token> --var-json key=json` → `rundown claim <token> --input-json key=json`
  - `rundown claim <token> --var-file path` → `rundown claim <token> --input-file path`
  - `RD_VAR_environment=staging rundown run` → `RD_INPUT_environment=staging rundown run`
  - `RD_VAR_<name>=<value>` description → `RD_INPUT_<name>=<value>`
  - `rundown run deploy.md --var environment=staging` → `rundown run deploy.md --input environment=staging`
  - `rundown run deploy.md --var-file base.yaml` → `rundown run deploy.md --input-file base.yaml`
  - `rundown run deploy.md --var API_KEY` → `rundown run deploy.md --input API_KEY`
  - `rundown run deploy.md --var-json 'items=...'` → `rundown run deploy.md --input-json 'items=...'`

### README.md

- [ ] **Step 2: Update README.md quick-start examples**

  ```bash
  grep -n "\-\-var\|RD_VAR_" README.md
  ```
  Apply the same replacements as CLAUDE.md.

### docs/ files

- [ ] **Step 3: Update docs/SPEC.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/SPEC.md
  ```
  Apply replacements to all flag references in the spec.

- [ ] **Step 4: Update docs/RUNDOWN.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/RUNDOWN.md
  ```

- [ ] **Step 5: Update docs/FORMAT.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/FORMAT.md
  ```

- [ ] **Step 6: Update docs/SECURITY.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/SECURITY.md
  ```

- [ ] **Step 7: Update docs/MCP.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/MCP.md
  ```

- [ ] **Step 8: Update docs/PROJECT-INTEGRATION.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/PROJECT-INTEGRATION.md
  ```

- [ ] **Step 9: Update docs/AGENT-ORCHESTRATION.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" docs/AGENT-ORCHESTRATION.md
  ```

- [ ] **Step 10: Update runbooks/README.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" runbooks/README.md
  ```

### Runbook example files

- [ ] **Step 11: Update all runbook files with --var references**

  ```bash
  grep -rl "\-\-var\|RD_VAR_" runbooks/
  ```

  Files expected to match (from the spec):
  - `runbooks/variables/variable-precedence.runbook.md`
  - `runbooks/variables/var-json-scalar.runbook.md`
  - `runbooks/variables/var-json-precedence.runbook.md`
  - `runbooks/variables/var-json-array.runbook.md`
  - `runbooks/for-loops/for-windowed-source.runbook.md`
  - `runbooks/for-loops/for-variable-source.runbook.md`
  - `runbooks/for-loops/for-variable-bounds.runbook.md`
  - `runbooks/for-loops/for-prompted-fallback.runbook.md`
  - `runbooks/for-loops/for-jsonl-source.runbook.md`
  - `runbooks/for-loops/for-file-source.runbook.md`
  - `runbooks/for-loops/for-array-source.runbook.md`
  - `runbooks/delegation/delegate-with-vars.runbook.md`
  - `runbooks/delegation/delegate-with-vars-child.runbook.md`
  - `runbooks/delegation/delegate-prompted-for.runbook.md`
  - `runbooks/context-passing/outputs-inputs.runbook.md`

  For each file, replace `--var-file` → `--input-file`, `--var ` → `--input `, `--var-json` → `--input-json`, `RD_VAR_` → `RD_INPUT_`.

### Plugin skill files

- [ ] **Step 12: Update running-runbooks SKILL.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" packages/claude-code-plugin/skills/running-runbooks/SKILL.md
  ```
  Apply replacements.

- [ ] **Step 13: Update writing-runbooks SKILL.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" packages/claude-code-plugin/skills/writing-runbooks/SKILL.md
  ```
  Apply replacements.

- [ ] **Step 14: Update delegating-runbooks SKILL.md**

  ```bash
  grep -n "\-\-var\|RD_VAR_" packages/claude-code-plugin/skills/delegating-runbooks/SKILL.md
  ```
  Apply replacements.

- [ ] **Step 15: Commit documentation changes**

  ```bash
  git add CLAUDE.md README.md docs/ runbooks/ packages/claude-code-plugin/skills/
  git commit -m "docs: rename --var/--var-json/--var-file/RD_VAR_* to --input/--input-json/--input-file/RD_INPUT_*"
  ```

---

## Task 11: Build verification

> **Must run last, after all previous tasks complete**

- [ ] **Step 1: Full build**

  ```bash
  npm run build 2>&1 | tail -30
  ```
  Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Full test suite**

  ```bash
  npm test 2>&1 | tail -30
  ```
  Expected: all tests pass, no `--var` references in failures.

- [ ] **Step 3: Confirm no remaining --var CLI flag references in source**

  ```bash
  grep -rn "'\-\-var'" packages/cli/src/ packages/claude-code-plugin/src/ packages/core/src/ packages/parser/src/
  ```
  Expected: zero matches (only string content, not the option definitions).

- [ ] **Step 4: Confirm no remaining RD_VAR_ references in source**

  ```bash
  grep -rn "RD_VAR_" packages/ --include="*.ts" --exclude-dir=".stryker-tmp"
  ```
  Expected: zero matches.

- [ ] **Step 5: Confirm no remaining varFile/varJson/varOpts/VarFlags in TypeScript source**

  ```bash
  grep -rn "\bvarFile\b\|\bvarJson\b\|\bvarOpts\b\|\bVarOptions\b\|\bparseVarOption\b\|\bparseVarJsonOption\b\|\bextractVarFileReferences\b\|\bENV_VAR_PREFIX\b\|\bVarFlags\b\|\bbuildChildVarFlags\b" packages/ --include="*.ts" --exclude-dir=".stryker-tmp"
  ```
  Expected: zero matches.

- [ ] **Step 6: Confirm no remaining ENV_VAR_PREFIX**

  ```bash
  grep -rn "ENV_VAR_PREFIX" packages/ --include="*.ts" --exclude-dir=".stryker-tmp"
  ```
  Expected: zero matches.

- [ ] **Step 7: Final commit if any stray cleanups needed, then verify**

  ```bash
  npm run verify 2>&1 | tail -20
  ```
  Expected: all checks pass (format, spell, lint, test).
