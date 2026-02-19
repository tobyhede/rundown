/**
 * CLI exit code constants for three-tier disambiguation.
 *
 * Scripts and parent processes can distinguish between runbook-level
 * failures and command-level errors by inspecting the exit code.
 *
 * @module helpers/exit-codes
 */

/** Command and runbook both succeeded. */
export const EXIT_SUCCESS = 0;

/** Command succeeded; runbook was stopped or failed. */
export const EXIT_RUNBOOK_FAILED = 1;

/** Command itself failed (CLI-level error). */
export const EXIT_COMMAND_ERROR = 2;
