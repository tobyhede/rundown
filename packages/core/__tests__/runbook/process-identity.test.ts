import { describe, it, expect } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createProcessIdentity,
  isAddressablePid,
  isOwnerAlive,
  parseProcStatStartTime,
  PS_CANONICAL_ENV,
  readProcessStartId,
  selectStartIdReader,
  sharedProcessIdentity,
  type ProcessIdentity,
} from '../../src/runbook/process-identity.js';

// ACCEPTED MUTATION SURVIVORS in process-identity.ts (#722).
//
//   stryker run --mutate src/runbook/process-identity.ts \
//     --testFiles __tests__/runbook/process-identity.test.ts --force
//
// What remains is platform-conditional or equivalent. Recorded so the next run
// reads the residue instead of re-deriving it:
//
//  - The WHOLE of the reader for the platform the run is NOT on (8 NoCoverage on
//    macOS: `readLinuxStartId`; the same for `readBsdStartId` on CI's Linux).
//    `selectStartIdReader` dispatches on the real `process.platform`, so exactly
//    one reader is dead code per host. The dispatch itself is pinned for both.
//  - `parseProcStatStartTime`'s `commEnd < 0` boundary. A line whose only `)` is
//    at index 0 has no field 22 either way, so `<` and `<=` agree.
//  - Its `startTime === undefined` disjunct. Dropping it falls through to the
//    regex, which rejects the string `"undefined"` — same result.
//  - `readBsdStartId`'s `ps` arguments, options object, empty-output guard,
//    catch block, and its `isAddressablePid` call. Every mutation of them makes
//    `ps` fail, hang, or return something unusable, and all of those already
//    answer `null`; the arguments that produce a DIFFERENT valid answer are not
//    reachable from a test that cannot control which processes exist. The guard
//    itself is pinned directly instead, for the reason its own docs give.
//  - `readProcessStartId`'s `?.` on the selected reader. It is never null on a
//    host this suite runs on — that arm is the unsupported platform, which
//    `selectStartIdReader` pins directly instead.
//  - `BSD_PS`'s literal. A module-constant initializer runs at import, so
//    Stryker cannot re-evaluate it per test (a "static" mutant).

/**
 * A pid that can never be alive: above every platform's pid_max (Linux 4194304,
 * macOS 99998), so `kill(pid, 0)` is always ESRCH and no `/proc` entry or `ps`
 * row can exist for it.
 *
 * A spawned-and-reaped pid is only dead until the OS recycles it. The same
 * constant is used by the lease property suite and the file-lock suites.
 */
const DEAD_PID = 999999999;

/** Whether this host is one of the two platforms that can supply a start id. */
const HOST_SUPPORTED = process.platform === 'linux' || process.platform === 'darwin';

/** Build one `/proc/<pid>/stat` line with the given comm and starttime. */
function procStat(comm: string, starttime: string): string {
  // Fields 1-2 then 3..52. starttime is field 22, i.e. index 19 after the comm.
  const after = [
    'S',
    '1',
    '1',
    '1',
    '0',
    '-1',
    '4194560',
    '100',
    '0',
    '0',
    '0',
    '9',
    '3',
    '0',
    '0',
    '20',
    '0',
    '4',
    '0',
    starttime,
  ];
  const tail = new Array(30).fill('0');
  return `4242 (${comm}) ${[...after, ...tail].join(' ')}\n`;
}

/** A ProcessIdentity backed by a fixed pid → start-id table. */
function fakeIdentity(table: Readonly<Record<number, string | null>>): ProcessIdentity {
  return { of: (pid) => table[pid] ?? null };
}

describe('parseProcStatStartTime', () => {
  it('reads field 22 from a well-formed stat line', () => {
    expect(parseProcStatStartTime(procStat('node', '918273'))).toBe('918273');
  });

  it('reads past a comm containing spaces and parentheses', () => {
    expect(parseProcStatStartTime(procStat('we (ir) d name', '55'))).toBe('55');
  });

  it('rejects a line with no closing parenthesis', () => {
    expect(
      parseProcStatStartTime('4242 node S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 4 0 55'),
    ).toBeNull();
  });

  it('rejects a truncated line that never reaches field 22', () => {
    expect(parseProcStatStartTime('4242 (node) S 1 1 1 0 -1')).toBeNull();
  });

  it('rejects a non-numeric starttime rather than comparing garbage', () => {
    expect(parseProcStatStartTime(procStat('node', 'x9'))).toBeNull();
  });

  it('rejects a negative starttime field', () => {
    expect(parseProcStatStartTime(procStat('node', '-1'))).toBeNull();
  });

  it('rejects a starttime with trailing garbage rather than reading its prefix', () => {
    // An unanchored match would accept `55x` as `55`, silently equating two
    // different processes whose fields happened to share a numeric prefix.
    expect(parseProcStatStartTime(procStat('node', '55x'))).toBeNull();
  });

  it('reads fields separated by runs of whitespace, not just single spaces', () => {
    // Splitting on a single whitespace character would emit empty tokens for a
    // run and shift every field past it — reading the wrong column entirely.
    const spaced = procStat('node', '918273').replace(/ /g, '   ');
    expect(parseProcStatStartTime(spaced)).toBe('918273');
  });
});

describe('isAddressablePid', () => {
  it('accepts a positive safe integer', () => {
    expect(isAddressablePid(1)).toBe(true);
    expect(isAddressablePid(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it.each([
    ['zero, which names a process GROUP to kill(2)', 0],
    ['a negative, which also names a process group', -1],
    ['a non-integer', 1.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', (_label, pid) => {
    expect(isAddressablePid(pid)).toBe(false);
  });
});

describe('selectStartIdReader', () => {
  it('supplies a reader on linux', () => {
    expect(selectStartIdReader('linux')).not.toBeNull();
  });

  it('supplies a reader on darwin', () => {
    expect(selectStartIdReader('darwin')).not.toBeNull();
  });

  it('supplies no reader on a platform with neither /proc nor BSD ps', () => {
    expect(selectStartIdReader('win32')).toBeNull();
  });
});

describe('readProcessStartId', () => {
  const maybe = HOST_SUPPORTED ? it : it.skip;
  /**
   * The pid-1 comparison additionally needs this process NOT to be pid 1, which
   * a container without an init shim makes false — jest itself would be pid 1
   * and the two reads would name one process. Comparing against a spawned child
   * instead is not the safer swap it looks like: BSD `lstart` has one-second
   * resolution, so a child spawned in the same second as its parent legitimately
   * matches. Boot time versus now is the comparison that cannot tie.
   */
  const maybeDistinct = HOST_SUPPORTED && process.pid !== 1 ? it : it.skip;

  maybe('reads a start id for this live process', () => {
    expect(readProcessStartId(process.pid)).toMatch(/\S/);
  });

  maybeDistinct(
    'reports a different start id for a process that started at a different time',
    () => {
      // pid 1 (init/launchd) started at boot; this process did not.
      expect(readProcessStartId(1)).not.toBe(readProcessStartId(process.pid));
    },
  );

  maybe(
    'reads a start id for a live child process',
    async () => {
      const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
        stdio: 'ignore',
      });
      try {
        const pid = child.pid;
        if (pid === undefined) throw new Error('child never got a pid');
        expect(readProcessStartId(pid)).toMatch(/\S/);
      } finally {
        child.kill('SIGKILL');
      }
    },
    20000,
  );

  it('returns null for a pid no process can hold', () => {
    expect(readProcessStartId(DEAD_PID)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'returns null for the unaddressable pid %p',
    (pid) => {
      expect(readProcessStartId(pid)).toBeNull();
    },
  );

  maybe('returns an id with no surrounding whitespace', () => {
    // `ps` pads and newline-terminates its output. An untrimmed value still
    // compares equal to another untrimmed one, so only a direct assertion
    // catches a lost trim — which would break comparison against any other
    // reader of the same fact, including the child fixture.
    const id = readProcessStartId(process.pid);
    expect(id).toBe(id?.trim());
  });

  maybe(
    'reads the same id for one process whatever the ambient timezone is',
    () => {
      // On BSD the id is a rendered date and `ps` renders it in the CALLER's
      // timezone. Two rundown processes with different `TZ` reading the same live
      // process must not disagree — a disagreement is proof of death, and would
      // hand a second owner a run the first is still executing.
      const original = process.env.TZ;
      try {
        process.env.TZ = 'UTC';
        const utc = readProcessStartId(process.pid);
        process.env.TZ = 'Australia/Sydney';
        const sydney = readProcessStartId(process.pid);

        expect(sydney).toBe(utc);
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    },
    20000,
  );

  it('pins the canonical ps environment', () => {
    expect(PS_CANONICAL_ENV).toEqual({ TZ: 'UTC', LC_ALL: 'C' });
  });
});

describe('createProcessIdentity', () => {
  it('reads this process start id exactly once, however often it is asked', () => {
    const seen: number[] = [];
    const identity = createProcessIdentity((pid) => {
      seen.push(pid);
      return 'self-id';
    });

    expect(identity.of(process.pid)).toBe('self-id');
    expect(identity.of(process.pid)).toBe('self-id');

    expect(seen).toEqual([process.pid]);
  });

  it('memoizes an unsupported host rather than re-probing it', () => {
    let calls = 0;
    const identity = createProcessIdentity(() => {
      calls += 1;
      return null;
    });

    expect(identity.of(process.pid)).toBeNull();
    expect(identity.of(process.pid)).toBeNull();

    expect(calls).toBe(1);
  });

  it('re-reads a foreign pid every time, because a reused pid must not be cached', () => {
    const ids = ['first', 'second'];
    const foreign = process.pid + 1;
    const identity = createProcessIdentity(() => ids.shift() ?? null);

    expect(identity.of(foreign)).toBe('first');
    expect(identity.of(foreign)).toBe('second');
  });

  it('defaults to the real host reader', () => {
    const identity = createProcessIdentity();
    expect(identity.of(process.pid)).toBe(readProcessStartId(process.pid));
  });
});

describe('sharedProcessIdentity', () => {
  it('is one instance for the whole process, so the memo is not per-caller', () => {
    // The lease service is constructed per mutation; a fresh identity each time
    // would pay the BSD `ps` spawn on every acquisition instead of once.
    expect(sharedProcessIdentity()).toBe(sharedProcessIdentity());
  });

  it('answers with the real host reader', () => {
    expect(sharedProcessIdentity().of(process.pid)).toBe(readProcessStartId(process.pid));
  });
});

describe('isOwnerAlive', () => {
  it('reports an absent owner dead without consulting the start id', () => {
    let consulted = false;
    const identity: ProcessIdentity = {
      of: () => {
        consulted = true;
        return 'anything';
      },
    };

    expect(isOwnerAlive(identity, DEAD_PID, 'recorded')).toBe(false);
    expect(consulted).toBe(false);
  });

  it('reports a live owner alive when the observed start id matches', () => {
    expect(isOwnerAlive(fakeIdentity({ [process.pid]: 'same' }), process.pid, 'same')).toBe(true);
  });

  it('reports a live pid dead when its start id proves the owner was replaced', () => {
    expect(isOwnerAlive(fakeIdentity({ [process.pid]: 'new' }), process.pid, 'old')).toBe(false);
  });

  it('reports a live pid alive when no start id was recorded', () => {
    expect(isOwnerAlive(fakeIdentity({ [process.pid]: 'new' }), process.pid, null)).toBe(true);
  });

  it('reports a live pid alive when the host cannot observe a start id now', () => {
    expect(isOwnerAlive(fakeIdentity({}), process.pid, 'old')).toBe(true);
  });
});
