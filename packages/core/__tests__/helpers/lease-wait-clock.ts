import type { LeaseWaitClock } from '../../src/runbook/storage/execution-lease.js';
import type {
  SqlDriver,
  SqlReadTransaction,
  SqlTransaction,
  SyncWork,
} from '../../src/runbook/storage/sql-driver.js';

/** A {@link LeaseWaitClock} running on virtual time, with the applied sleeps recorded. */
export interface FakeWaitClock extends LeaseWaitClock {
  /** Milliseconds passed to each `sleep`, in call order — the APPLIED delay, post-cap. */
  readonly sleeps: number[];
  /** Virtual milliseconds elapsed since construction. */
  elapsed(): number;
  /**
   * Advance virtual time without sleeping.
   *
   * Models work that consumes budget outside the backoff — e.g. a slow
   * dead-owner recovery probe between the deadline check and the
   * remaining-budget read.
   *
   * @param ms - Milliseconds to advance.
   */
  advance(ms: number): void;
}

/** Construction options for {@link makeFakeWaitClock}. */
export interface FakeWaitClockOptions {
  /**
   * Invoked after each sleep is recorded and virtual time advances, but before
   * the sleep resolves — so aborting here models "the signal fired while we were
   * sleeping", which is what the loop's post-sleep check must observe.
   */
  readonly onSleep?: (sleepCount: number) => void;
  /**
   * Runaway guard; throws once `sleep` has been called this many times.
   *
   * Counts calls rather than {@link FakeWaitClock.sleeps} entries, so an
   * aborted sleep — which applies no delay and so records nothing — cannot
   * spin past the guard.
   */
  readonly maxSleeps?: number;
}

/**
 * A virtual-time {@link LeaseWaitClock} for driving `withWait` deterministically.
 *
 * Time advances ONLY through `sleep` and {@link FakeWaitClock.advance}, never on
 * its own. That is what makes the loop's arithmetic exact to assert against — the
 * budget is consumed by the delays the loop chose, not by however long SQLite
 * happened to take — and it is why `maxSleeps` exists: a mutation that zeroes the
 * backoff, or drops one of the retry-immediately guards, would otherwise spin
 * forever against a frozen clock. The cap turns that into a fast, labelled
 * failure instead of a hung suite (or a 60s Stryker timeout).
 *
 * @param options - Sleep hook and runaway cap.
 * @returns The fake clock with its recorders.
 */
export function makeFakeWaitClock(options: FakeWaitClockOptions = {}): FakeWaitClock {
  const maxSleeps = options.maxSleeps ?? 64;
  const sleeps: number[] = [];
  let virtualNow = 0;
  let sleepCalls = 0;

  return {
    sleeps,
    now: () => virtualNow,
    elapsed: () => virtualNow,
    advance: (ms) => {
      virtualNow += ms;
    },
    sleep: (ms, signal) => {
      // The cap counts every call, including the aborted ones the fast path
      // below skips: an aborted sleep advances no virtual time either, so it
      // is just as able to spin forever against a frozen clock.
      sleepCalls += 1;
      if (sleepCalls > maxSleeps) {
        throw new Error(
          `FakeWaitClock: runaway wait loop — ${String(sleepCalls)} sleeps exceeds the ` +
            `${String(maxSleeps)} cap. Virtual time only advances on sleep, so a zero-length ` +
            'backoff or a missing loop exit never reaches its deadline. Applied delays: ' +
            sleeps.join(', '),
        );
      }
      // An already-aborted signal returns before the real clock schedules a
      // timer, so nothing is applied — not virtual time, and not a `sleeps`
      // entry, which is documented as the APPLIED delay.
      if (signal?.aborted === true) {
        return Promise.resolve();
      }
      sleeps.push(ms);
      virtualNow += ms;
      options.onSleep?.(sleeps.length);
      return Promise.resolve();
    },
  };
}

/** Recorded driver traffic, with a seam for interposing between calls. */
export interface DriverCallRecorder {
  /** `'read'` / `'immediate'` in call order, recorded when each call is made. */
  readonly calls: ('read' | 'immediate')[];
  /**
   * Count calls of one kind.
   *
   * @param kind - Transaction kind to count.
   * @returns How many calls of that kind were made.
   */
  count(kind: 'read' | 'immediate'): number;
  /**
   * Run `hook` immediately after the nth `read` resolves, once.
   *
   * The dead-owner recovery probe is a `read`, so this is the seam for modelling
   * a concurrent actor that changes the run between the observation and the
   * exact-tuple CAS that acts on it.
   *
   * @param n - 1-based read ordinal to interpose after.
   * @param hook - Work to perform before the caller sees the read's result.
   */
  afterRead(n: number, hook: () => void | Promise<void>): void;
  /** Restore the driver's original methods. */
  restore(): void;
}

/**
 * Record (and optionally interpose on) a driver's transaction traffic.
 *
 * One acquisition attempt is exactly one `immediate`; one dead-owner recovery
 * probe is exactly one `read`. Asserting that sequence is how a test pins how
 * many attempts the wait loop made — which no other observation can do, because
 * `withWait`'s post-sleep deadline check is a redundant guard for the same
 * condition as its loop-top check: dropping the post-sleep return costs exactly
 * one extra acquisition and changes nothing else the caller can see.
 *
 * Patches the instance's own properties rather than using `jest.spyOn`, whose
 * mock typing cannot express these generic signatures without casting away the
 * transaction types this helper exists to preserve.
 *
 * @param driver - Driver to instrument, normally the per-test instance.
 * @returns The recorder.
 */
export function recordDriverCalls(driver: SqlDriver): DriverCallRecorder {
  const calls: ('read' | 'immediate')[] = [];
  const realRead = driver.read.bind(driver);
  const realImmediate = driver.immediate.bind(driver);
  const readHooks = new Map<number, () => void | Promise<void>>();
  let reads = 0;

  const patched = driver as {
    read: SqlDriver['read'];
    immediate: SqlDriver['immediate'];
  };

  patched.read = async <T>(work: (tx: SqlReadTransaction) => SyncWork<T>): Promise<T> => {
    calls.push('read');
    // Pin this call's ordinal before awaiting: `reads` is shared, so a read
    // that starts while this one is in flight would otherwise redirect both
    // continuations to the later ordinal.
    const ordinal = ++reads;
    const result = await realRead(work);
    const hook = readHooks.get(ordinal);
    if (hook !== undefined) {
      readHooks.delete(ordinal);
      await hook();
    }
    return result;
  };

  patched.immediate = <T>(work: (tx: SqlTransaction) => SyncWork<T>): Promise<T> => {
    calls.push('immediate');
    return realImmediate(work);
  };

  return {
    calls,
    count: (kind) => calls.filter((call) => call === kind).length,
    afterRead: (n, hook) => {
      readHooks.set(n, hook);
    },
    restore: () => {
      patched.read = realRead;
      patched.immediate = realImmediate;
    },
  };
}
