import { describe, expect, it } from '@jest/globals';
import type { SqlDriver } from '../../src/runbook/storage/sql-driver.js';
import { makeFakeWaitClock, recordDriverCalls } from './lease-wait-clock.js';

/**
 * A driver whose reads resolve only when the test releases them, so two reads
 * can be held in flight at once.
 */
function makeGatedDriver(): { driver: SqlDriver; release: (() => void)[] } {
  const release: (() => void)[] = [];
  const driver = {
    read: () =>
      new Promise<void>((resolve) => {
        release.push(resolve);
      }),
    immediate: () => Promise.resolve(),
  } as unknown as SqlDriver;
  return { driver, release };
}

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

describe('recordDriverCalls', () => {
  it('runs each read hook for its own call ordinal when reads overlap', async () => {
    const { driver, release } = makeGatedDriver();
    const recorder = recordDriverCalls(driver);
    const fired: number[] = [];
    recorder.afterRead(1, () => {
      fired.push(1);
    });
    recorder.afterRead(2, () => {
      fired.push(2);
    });

    // Second read starts before the first resolves. Reading the shared counter
    // after the await makes both continuations see the later ordinal, so the
    // first read's hook is skipped and the second's is consumed early.
    const first = driver.read(() => undefined);
    const second = driver.read(() => undefined);
    release[0]?.();
    release[1]?.();
    await first;
    await second;

    expect(fired).toEqual([1, 2]);
    recorder.restore();
  });
});
