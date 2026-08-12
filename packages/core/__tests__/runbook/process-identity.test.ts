import { describe, it, expect } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createProcessIdentity,
  isAddressablePid,
  isOwnerAlive,
  parseProcStatStartTime,
  PS_CANONICAL_ENV,
  readBsdStartId,
  readLinuxStartId,
  readProcessStartId,
  selectStartIdReader,
  sharedProcessIdentity,
  type ProcessIdentity,
  type PsRunner,
} from '../../src/runbook/process-identity.js';

// ACCEPTED MUTATION SURVIVORS in process-identity.ts (#722, revised in #742).
//
//   stryker run --mutate src/runbook/process-identity.ts \
//     --testFiles __tests__/runbook/process-identity.test.ts --force
//
// Most of what this ledger used to list was NOT equivalent — it was untestable
// only for as long as the two readers reached the host directly. Injecting that
// one call each (`StatFileReader`, `PsRunner`) made the whole of both readers
// reachable on any host, which killed the platform-conditional entry, the whole
// `readBsdStartId` entry, and the `readProcessStartId` `?.` entry. The
// `commEnd < 0` entry was simply wrong: a line whose only `)` is at index 0
// still carries every field after it, so `<` reads field 22 where `<=` returns
// null, and 'accepts a line whose closing parenthesis is its first character'
// kills it. Two survivors remain, and both are real:
//
//  - `parseProcStatStartTime`'s `startTime === undefined` disjunct. Dropping it
//    falls through to the regex, which rejects the string `"undefined"` — same
//    result. The check earns its place by narrowing `string | undefined` for the
//    return, not by deciding anything at runtime.
//  - `BSD_PS`'s literal. A module-constant initializer runs at import, before
//    Stryker's per-test mutant switch is set, so the mutated value never reaches
//    `readBsdStartId` however the test is written (a "static" mutant). CI does
//    not report it — the advisory PR gate sets `STRYKER_IGNORE_STATIC=true` —
//    but a local `test:mutate:changed` does, because `ignoreStatic` defaults to
//    false. The path itself IS asserted, by 'asks /bin/ps for exactly that pid'.

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

/**
 * Pids that name no single process, and so must never reach a `/proc` path or a
 * `ps` argument.
 *
 * `0` and negatives are process-*group* targets; the last two are not safe
 * integers, so neither would build the path or the argument the caller meant.
 *
 * Every one of these yields `null` whether the guard runs or not — a rejected
 * pid and a failed probe are the same answer — so the guard's only observable
 * effect is that the host call is not attempted. That is what the cases below
 * assert.
 */
const NON_ADDRESSABLE_PIDS = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1] as const;

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

  it('accepts a line whose closing parenthesis is its first character', () => {
    // `lastIndexOf` returns 0 here, which is a valid index — only -1 means "no
    // comm at all". Rejecting index 0 would discard a line that parses fine:
    // every field still follows it, so `<` reads field 22 where `<=` returns
    // null. The two do NOT agree, which is why this boundary is worth a case.
    const line = procStat('node', '918273');
    expect(parseProcStatStartTime(line.slice(line.indexOf(')')))).toBe('918273');
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
  it('supplies the /proc reader on linux', () => {
    expect(selectStartIdReader('linux')).toBe(readLinuxStartId);
  });

  it('supplies the BSD ps reader on darwin', () => {
    expect(selectStartIdReader('darwin')).toBe(readBsdStartId);
  });

  it('supplies no reader on a platform with neither /proc nor BSD ps', () => {
    expect(selectStartIdReader('win32')).toBeNull();
  });
});

// Both readers are exercised through their injected host call rather than
// through the host itself. Only one of them is ever the live reader on any one
// machine, so testing them via `readProcessStartId` covers whichever half the
// runner happens to be — and leaves the other half entirely unexecuted. That is
// exactly what a mutation run on CI reported: 22 uncovered mutants across the
// BSD reader on a Linux runner, and the mirror image on macOS.
describe('readLinuxStartId', () => {
  it('reads field 22 from the stat file of the pid it was asked about', () => {
    const reads: [string, string][] = [];
    const readStatFile = (path: string, encoding: 'utf8'): string => {
      reads.push([path, encoding]);
      return procStat('node', '918273');
    };

    expect(readLinuxStartId(4242, readStatFile)).toBe('918273');
    expect(reads).toEqual([['/proc/4242/stat', 'utf8']]);
  });

  it('reports null when the stat read throws rather than propagating', () => {
    // ENOENT (process gone), EACCES, or no /proc at all — every one is "unknown",
    // and "unknown" must reach the caller as a value, not as a thrown error.
    expect(
      readLinuxStartId(4242, () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }),
    ).toBeNull();
  });

  it.each(NON_ADDRESSABLE_PIDS)('never opens a /proc path for pid %p', (pid) => {
    let attempted = false;
    const readStatFile = (): string => {
      attempted = true;
      return procStat('node', '918273');
    };

    expect(readLinuxStartId(pid, readStatFile)).toBeNull();
    expect(attempted).toBe(false);
  });
});

describe('readBsdStartId', () => {
  it('asks /bin/ps for exactly that pid, with the rendering pinned', () => {
    const calls: Parameters<PsRunner>[] = [];
    const runPs: PsRunner = (...args) => {
      calls.push(args);
      return 'Tue Aug 12 05:14:23 2026\n';
    };

    expect(readBsdStartId(4242, runPs)).toBe('Tue Aug 12 05:14:23 2026');

    expect(calls).toHaveLength(1);
    const [file, args, options] = calls[0];
    // The absolute path is the point: a `ps` shadowed earlier on PATH could
    // induce a start-id mismatch and hand a second owner an already-owned run.
    expect(file).toBe('/bin/ps');
    expect(args).toEqual(['-o', 'lstart=', '-p', '4242']);
    expect(options.encoding).toBe('utf8');
    expect(options.timeout).toBe(2000);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'ignore']);
  });

  it('pins the date rendering over the ambient environment, and inherits the rest', () => {
    const originalTz = process.env.TZ;
    const originalProbe = process.env.RD_PS_AMBIENT_PROBE;
    process.env.TZ = 'Australia/Sydney';
    process.env.RD_PS_AMBIENT_PROBE = 'inherited';
    try {
      let env: NodeJS.ProcessEnv | undefined;
      readBsdStartId(4242, (_file, _args, options) => {
        env = options.env;
        return 'Tue Aug 12 05:14:23 2026';
      });

      // A reader on Sydney time and a writer on UTC would render the same live
      // process differently, and a mismatch is read as proof of death.
      expect(env?.TZ).toBe('UTC');
      expect(env?.LC_ALL).toBe('C');
      expect(env?.RD_PS_AMBIENT_PROBE).toBe('inherited');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
      if (originalProbe === undefined) delete process.env.RD_PS_AMBIENT_PROBE;
      else process.env.RD_PS_AMBIENT_PROBE = originalProbe;
    }
  });

  it('trims the column padding ps writes around the date', () => {
    expect(readBsdStartId(4242, () => '  Tue Aug 12 05:14:23 2026  \n')).toBe(
      'Tue Aug 12 05:14:23 2026',
    );
  });

  it('reports null when ps names no row for the pid', () => {
    // A blank column is `ps` saying the process is gone, not an identity.
    expect(readBsdStartId(4242, () => '  \n')).toBeNull();
  });

  it('reports null when ps cannot run at all', () => {
    // Non-zero exit, a timeout, or a host that cannot spawn (WebContainer, a
    // restrictive sandbox). All are "unknown".
    expect(
      readBsdStartId(4242, () => {
        throw new Error('spawn EPERM');
      }),
    ).toBeNull();
  });

  it.each(NON_ADDRESSABLE_PIDS)('never spawns ps for pid %p', (pid) => {
    let attempted = false;
    const runPs: PsRunner = () => {
      attempted = true;
      return 'Tue Aug 12 05:14:23 2026';
    };

    expect(readBsdStartId(pid, runPs)).toBeNull();
    expect(attempted).toBe(false);
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

  it('answers null on a host with no reader at all, rather than throwing', () => {
    // Windows has neither /proc nor BSD `ps`, so the dispatch yields nothing to
    // call. "No start id" is a supported answer — it drops the decision back to
    // pid-only — so this must not be a crash on the acquisition path.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platform === undefined) throw new Error('process.platform is not configurable');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(readProcessStartId(process.pid)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
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
