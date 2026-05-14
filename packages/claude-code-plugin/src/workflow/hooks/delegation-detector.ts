// src/workflow/hooks/delegation-detector.ts

import { findDelegationClaimToken } from '@rundown-org/core';

/**
 * Result of detecting a delegation marker in text.
 */
export interface DelegationDetection {
  /** Extracted raw delegation token */
  token: string;
}

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

  const token = findDelegationClaimToken(text);
  if (!token) return null;

  return { token };
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
