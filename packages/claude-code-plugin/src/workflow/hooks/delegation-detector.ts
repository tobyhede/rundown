// src/workflow/hooks/delegation-detector.ts

/**
 * Result of detecting a delegation marker in text.
 */
export interface DelegationDetection {
  /** Extracted raw delegation token */
  token: string;
}

/**
 * Pattern for canonical delegation marker.
 * Matches `RD_CLAIM_TOKEN=rdtk_<32 base32 chars>` at the start of a line.
 * Multiline flag ensures `^` matches line starts, first match wins.
 */
const CLAIM_MARKER_PATTERN = /^RD_CLAIM_TOKEN=(rdtk_[A-Z0-9]{32})$/m;

/**
 * Detect a delegation marker in a single text field.
 *
 * @param text - Text to scan for a delegation marker
 * @returns Detection result with token, or null if no marker found
 */
export function detectDelegationMarker(text: string): DelegationDetection | null {
  if (!text) return null;

  const match = CLAIM_MARKER_PATTERN.exec(text);
  if (!match) return null;

  return { token: match[1] };
}

/**
 * Detect a delegation marker in Task tool input fields.
 * Scans prompt first, then falls back to description.
 *
 * @param prompt - Task prompt field
 * @param description - Task description field
 * @returns Detection result with token, or null if no marker found
 */
export function detectDelegationInTaskInput(
  prompt?: string,
  description?: string,
): DelegationDetection | null {
  if (prompt) {
    const result = detectDelegationMarker(prompt);
    if (result) return result;
  }

  if (description) {
    return detectDelegationMarker(description);
  }

  return null;
}
