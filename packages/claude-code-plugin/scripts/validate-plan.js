#!/usr/bin/env node
/**
 * Validate a plan JSON file against schema and structural checks.
 * Pattern: mirrors scripts/validate-runbooks.js
 *
 * Usage: node scripts/validate-plan.js <plan.json>
 *
 * Exit codes:
 *   0 — schema valid, no structural errors (warnings OK)
 *   1 — schema invalid, structural errors, or file/parse failure
 */
import { readFileSync } from 'node:fs';
import { validate } from '../dist/plan-schema.js';
import { validatePlanStructure } from '../dist/plan-validators.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: validate-plan.js <plan.json>');
  process.exit(1);
}

// Read and parse
let raw;
try {
  raw = readFileSync(file, 'utf-8');
} catch {
  console.error(`error: cannot read file: ${file}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error(`error: invalid JSON in ${file}`);
  process.exit(1);
}

// Schema validation
let plan;
try {
  plan = validate(data);
} catch (error) {
  console.error(`FAIL: schema validation failed for ${file}`);
  if (error && typeof error === 'object' && 'issues' in error) {
    for (const issue of /** @type {any} */ (error).issues) {
      const path = issue.path?.join('/') ?? '';
      console.error(`  /${path}: ${issue.message}`);
    }
  } else {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

// Structural validation
const result = validatePlanStructure(plan);

const errors = result.issues.filter((i) => i.severity === 'error');
const warnings = result.issues.filter((i) => i.severity === 'warning');

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} structural error(s) in ${file}`);
  for (const issue of errors) {
    console.error(`  ERROR [${issue.rule}] ${issue.path}: ${issue.message}`);
  }
  for (const issue of warnings) {
    console.error(`  WARN  [${issue.rule}] ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

const warnMsg = warnings.length > 0 ? `, ${warnings.length} warning(s)` : '';
console.log(`PASS: schema valid, 0 structural errors${warnMsg}`);
if (warnings.length > 0) {
  for (const issue of warnings) {
    console.warn(`  WARN  [${issue.rule}] ${issue.path}: ${issue.message}`);
  }
}
