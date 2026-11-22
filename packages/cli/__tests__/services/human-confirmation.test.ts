/**
 * The human's answer at a terminal (#906): a yes/no question read over the
 * real `readline`, driven through PassThrough streams. An abort — the input
 * ending (Ctrl-D) or Ctrl-C — is an answer too: no.
 */
import { describe, expect, it } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { streamHumanConfirmation } from '../../src/services/human-confirmation.js';

/** Settle within `ms`, or report that the question never settled. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T | 'unsettled'> {
  return Promise.race([
    promise,
    new Promise<'unsettled'>((resolve) => {
      setTimeout(() => {
        resolve('unsettled');
      }, ms).unref();
    }),
  ]);
}

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString()));
  return { input, output, written };
}

describe('streamHumanConfirmation', () => {
  it('asks with the [y/N] suffix and reads an explicit yes', async () => {
    const { input, output, written } = streams();
    const answer = streamHumanConfirmation(input, output).confirm('Stop it?');
    input.write('y\n');

    expect(await within(answer)).toBe(true);
    expect(written.join('')).toContain('Stop it? [y/N] ');
  });

  it('reads anything else as no', async () => {
    const { input, output } = streams();
    const answer = streamHumanConfirmation(input, output).confirm('Stop it?');
    input.write('\n');

    expect(await within(answer)).toBe(false);
  });

  it('reads the input ending (Ctrl-D) as no', async () => {
    const { input, output } = streams();
    const answer = streamHumanConfirmation(input, output).confirm('Stop it?');
    input.end();

    expect(await within(answer)).toBe(false);
  });

  it('reads Ctrl-C at a terminal as no', async () => {
    const { input, output } = streams();
    const answer = streamHumanConfirmation(input, output, { terminal: true }).confirm('Stop it?');
    input.write('\x03');

    expect(await within(answer)).toBe(false);
  });
});
