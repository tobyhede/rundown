/**
 * ANSI escape code sequences for terminal colors.
 * Uses standard 16-color palette for maximum compatibility.
 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** Cache for color support detection */
let _colorEnabled: boolean | null = null;

/**
 * Detect if colors should be enabled.
 *
 * Respects NO_COLOR env var (https://no-color.org/),
 * FORCE_COLOR env var, and TTY detection.
 *
 * @returns true if colors should be used
 */
export function isColorEnabled(): boolean {
  if (_colorEnabled !== null) return _colorEnabled;

  // NO_COLOR takes precedence (standard: https://no-color.org/)
  if (process.env.NO_COLOR !== undefined) {
    _colorEnabled = false;
    return false;
  }

  // FORCE_COLOR overrides TTY detection
  if (process.env.FORCE_COLOR !== undefined) {
    _colorEnabled = process.env.FORCE_COLOR !== '0';
    return _colorEnabled;
  }

  // Check if stdout is a TTY
  _colorEnabled = process.stdout.isTTY === true;
  return _colorEnabled;
}

/**
 * Programmatically enable or disable colors.
 * Used by --no-color flag handler.
 *
 * @param enabled - Whether colors should be enabled
 */
export function setColorEnabled(enabled: boolean): void {
  _colorEnabled = enabled;
}

/**
 * Reset color detection cache.
 * Primarily used for testing.
 */
export function resetColorCache(): void {
  _colorEnabled = null;
}

/**
 * Apply ANSI color codes to text if colors are enabled.
 *
 * @param text - The text to colorize
 * @param codes - ANSI codes to apply
 * @returns Colored text or plain text if colors disabled
 */
function colorize(text: string, ...codes: string[]): string {
  if (!isColorEnabled()) return text;
  return codes.join('') + text + ANSI.reset;
}

// ============================================
// Semantic color functions
// ============================================

/**
 * Style for success/pass results - green.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const success = (text: string): string => colorize(text, ANSI.green);

/**
 * Style for failure/fail results - red.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const failure = (text: string): string => colorize(text, ANSI.red);

/**
 * Style for warnings - yellow.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const warning = (text: string): string => colorize(text, ANSI.yellow);

/**
 * Style for informational messages - cyan.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const info = (text: string): string => colorize(text, ANSI.cyan);

/**
 * Style for dimmed/secondary text - gray.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const dim = (text: string): string => colorize(text, ANSI.gray);

/**
 * Style for bold emphasis.
 *
 * @param text - Text to style
 * @returns Styled text
 */
export const bold = (text: string): string => colorize(text, ANSI.bold);

/**
 * Apply status-appropriate coloring to a status string.
 *
 * @param status - The status string to colorize
 * @returns Colorized status string
 */
export function colorizeStatus(status: string): string {
  switch (status.toLowerCase()) {
    case 'active':
    case 'running':
      return success(status);
    case 'stashed':
      return warning(status);
    case 'complete':
    case 'completed':
      return info(status);
    case 'stopped':
    case 'failed':
      return failure(status);
    case 'inactive':
    default:
      return dim(status);
  }
}

/**
 * Apply result-appropriate coloring (PASS/FAIL).
 *
 * @param result - The result string to colorize
 * @returns Colorized result string
 */
export function colorizeResult(result: string): string {
  const upper = result.toUpperCase();
  if (upper === 'PASS') return success(result);
  if (upper === 'FAIL') return failure(result);
  return result;
}
