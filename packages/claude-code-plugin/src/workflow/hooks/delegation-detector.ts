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
 * Matches `RD_CLAIM_TOKEN=rdtk_<32 alphanumeric chars>` anywhere in text.
 *
 * Character class uses [A-Z0-9] (broader than strict RFC 4648 base32 [A-Z2-7])
 * to match the token format defined in `@rundown-org/core`'s token generator.
 *
 * The `rdtk_` prefix + 32 uppercase alphanumeric chars is distinctive enough
 * to match reliably without line anchoring. First match wins.
 */
const CLAIM_MARKER_PATTERN = /RD_CLAIM_TOKEN=(rdtk_[A-Z0-9]{32})/;

/**
 * Finds a delegation marker in a text field.
 *
 * Scans the provided text for a canonical RD_CLAIM_TOKEN line and, if present, returns the captured raw token.
 *
 * @param text - Text to scan for a delegation marker
 * @returns The detected `DelegationDetection` with the extracted `token`, or `null` if no marker is found
 */
export function detectDelegationMarker(text: string): DelegationDetection | null {
  if (!text) return null;

  const match = CLAIM_MARKER_PATTERN.exec(text);
  if (!match) return null;

  return { token: match[1] };
}

/**
 * Detect a delegation marker in Agent/Task tool input fields.
 * Scans prompt first, then falls back to description.
 *
 * @param prompt - Agent/Task prompt field
 * @param description - Agent/Task description field
 * @returns Detection result with token, or null if no marker found
 */
export function detectDelegationInToolInput(
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
