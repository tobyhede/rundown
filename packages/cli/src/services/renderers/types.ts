/**
 * Renderer interface definitions for the Output Emitter pattern.
 *
 * Renderers transform OutputEvents into formatted output (text or JSON).
 *
 * @module renderers/types
 */

import type { OutputEvent } from '@rundown-org/core';
import type { OutputWriter } from '@rundown-org/core';

/**
 * Interface for output renderers.
 *
 * Renderers handle the actual formatting and output of events.
 * TextRenderer outputs human-readable formatted text.
 * JSONRenderer outputs machine-readable JSON.
 */
export interface OutputRenderer {
  /**
   * Render an output event.
   *
   * @param event - The output event to render
   */
  render(event: OutputEvent): void;

  /**
   * Flush any buffered output.
   *
   * For JSONRenderer, this outputs the accumulated JSON object.
   * For TextRenderer, this is typically a no-op.
   */
  flush(): void;
}

/**
 * Options for creating a renderer.
 */
export interface RendererOptions {
  /** Custom writer to use for output (defaults to ConsoleWriter) */
  writer?: OutputWriter;
}
