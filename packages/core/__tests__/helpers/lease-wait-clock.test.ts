import { describe, expect, it } from '@jest/globals';
import { makeFakeWaitClock } from './lease-wait-clock.js';

describe('makeFakeWaitClock', () => {
  it('records no applied sleep when the signal is already aborted', async () => {
    const applied: number[] = [];
    const clock = makeFakeWaitClock({ onSleep: (count) => applied.push(count) });
    const controller = new AbortController();
    controller.abort();

    await clock.sleep(10, controller.signal);

    // The real clock returns before scheduling a timer, so no delay is applied.
    // `sleeps` is documented as the APPLIED delay; a phantom entry would let a
    // test assert a wait that production never performs.
    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed()).toBe(0);
    expect(applied).toEqual([]);
  });

  it('still trips the runaway guard when every sleep is already aborted', async () => {
    const clock = makeFakeWaitClock({ maxSleeps: 3 });
    const controller = new AbortController();
    controller.abort();

    // Aborted sleeps apply no delay, so virtual time can never reach a
    // deadline. The cap is the only thing standing between a loop that fails
    // to exit and a hung suite, so it must count calls the fast path skips.
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await clock.sleep(10, controller.signal);
        }
      })(),
    ).rejects.toThrow(/runaway wait loop/);
  });
});
