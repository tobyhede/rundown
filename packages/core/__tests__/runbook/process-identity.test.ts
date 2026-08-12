import { describe, it, expect } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fsSync from 'node:fs';
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
  type StartIdReader,
} from '../../src/runbook/process-identity.js';

// ACCEPTED MUTATION SURVIVORS in process-identity.ts (#722).
//
//   stryker run --mutate src/runbook/process-identity.ts \
//     --testFiles __tests__/runbook/process-identity.test.ts --force
//
// 13 of 98 alive on a macOS run (86.73%), none of them NoCoverage. Which
// mutants those are is host-dependent, so the LIST is what to trust, not the
// count: `selectStartIdReader` hands back a platform's reader on any host, so
// both readers are CALLED here, but only the one this host can answer with can
// be asked to tell a good read from a failed one.
//
// In the reader this host CAN answer with (`readBsdStartId` here; both on CI,
// whose `/bin/ps` understands `-o lstart=`):
//
//  - Its `isAddressablePid` call, in the "skip the guard" direction only. Every
//    pid the guard rejects is ALSO rejected by `/proc` and by `ps`, so both
//    paths answer `null`. Inverting or forcing the guard IS killed — those
//    change a live pid's answer. The guard is pinned directly instead, for the
//    reason its own docs give.
//  - `readBsdStartId`'s `stdio` array, its stderr entry, and its `env`. An
//    emptied array still pipes (Node fills the missing entries), an emptied
//    stderr spec is not read either way, and an emptied `env` only stops `ps`
//    inheriting an ambient `TZ`/locale that {@link PS_CANONICAL_ENV} overrides
//    anyway — so every one still yields the same id. The stdin and stdout
//    entries ARE killed; they are what makes the output readable at all.
//  - Its `out === ''` guard, in the two directions that still return `out`.
//    `ps` emits a row or fails; empty output is a shape it has never produced,
//    so that guard is defence against a host that does, not a live branch.
//
// In the reader this host CANNOT answer with, everything a successful read
// would be needed to distinguish: here `readLinuxStartId`'s `/proc` path
// strings and all three directions of its guard, since a reader that always
// fails answers `null` to every input. Four of those five are Killed on CI's
// Linux; the fifth is the skip-the-guard equivalent above, which is all that
// guard ever leaves behind in a reader that can answer. Mirror image, same
// trade. See {@link ANSWERING_PLATFORMS}.
//
// Host-independent:
//
//  - `parseProcStatStartTime`'s `startTime === undefined` disjunct. Dropping it
//    falls through to the regex, which rejects the string `"undefined"` — same
//    result.
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

/** The reader for a platform `selectStartIdReader` is known to supply one for. */
function readerFor(platform: 'linux' | 'darwin'): StartIdReader {
  const read = selectStartIdReader(platform);
  if (read === null) throw new Error(`no start-id reader for ${platform}`);
  return read;
}

/**
 * The platforms whose reader can actually ANSWER on this host.
 *
 * Either reader can be CALLED anywhere — `selectStartIdReader` dispatches on the
 * platform it is handed, not on the one it is running on. Whether the call can
 * succeed is a separate question: `/proc` is Linux-only, and only a host with a
 * BSD-compatible `ps` understands `-o lstart=`. That distinction is the whole
 * shape of this file's residue, because a reader that can only ever fail here
 * answers `null` to every input, and no assertion can separate its arguments
 * from any other arguments that also fail.
 *
 * Both halves are probed with plain Node against this process — which is
 * certainly alive — rather than by calling the reader. A probe that ran the
 * code under test would be MUTATED along with it, and any mutant that broke a
 * reader would delete the very test that catches it, reporting itself as
 * survived. The duplicated knowledge is the price of a probe that holds still.
 */
const ANSWERING_PLATFORMS: readonly ('linux' | 'darwin')[] = [
  ...(fsSync.existsSync(`/proc/${String(process.pid)}/stat`) ? (['linux'] as const) : []),
  ...(spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' })
    .status === 0
    ? (['darwin'] as const)
    : []),
];

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

  it('reads field 22 from a line whose only parenthesis is its first character', () => {
    // The guard rejects a line carrying NO `)`, not one whose `)` sits at index
    // 0: an empty comm leaves every field exactly where it belongs. Reading the
    // boundary as `<= 0` would throw that line away as unparseable.
    const line = procStat('', '918273').replace('4242 (', '');
    expect(line.startsWith(')')).toBe(true);
    expect(parseProcStatStartTime(line)).toBe('918273');
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

describe('the platform readers, called directly rather than through the dispatch', () => {
  it.each([['linux'], ['darwin']] as const)(
    'the %s reader answers null — never undefined — for a pid nothing can hold',
    (platform) => {
      // Both readers are callable on any host: `/proc/<pid>/stat` is simply
      // absent off Linux, and `ps` exits non-zero (or is missing entirely) for a
      // pid no process holds. Every one of those is the same answer, "unknown".
      //
      // `readProcessStartId`'s `?? null` launders an `undefined` into a `null`,
      // so a reader that lost its `return null` would still look correct through
      // the dispatch. Only a direct call pins the reader's half of the contract.
      expect(readerFor(platform)(DEAD_PID)).toBeNull();
    },
  );

  for (const platform of ANSWERING_PLATFORMS) {
    it(`the ${platform} reader reads one trimmed, non-empty id for a live process`, () => {
      const id = readerFor(platform)(process.pid);

      expect(id).toMatch(/\S/);
      // `ps` pads and newline-terminates; an untrimmed id still compares equal
      // to another untrimmed one, so only a direct assertion catches a lost trim.
      expect(id).toBe(id?.trim());
      // ONE process's id, not a listing. An argument vector that stopped
      // selecting this pid — or stopped selecting a pid at all — would still
      // return something matching /\S/.
      expect(id).not.toContain('\n');
    });
  }
});

describe('readProcessStartId', () => {
  const maybe = HOST_SUPPORTED ? it : it.skip;

  maybe('reads a start id for this live process', () => {
    expect(readProcessStartId(process.pid)).toMatch(/\S/);
  });

  // Skipped when the runner IS pid 1 — a container without an init reaps node
  // straight onto it, and then both reads name the same process, so the premise
  // ("two processes that started at different times") does not hold.
  const onDistinctPid = maybe === it && process.pid !== 1 ? it : it.skip;

  onDistinctPid(
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
    // The optional call on the selected reader is the whole of what stands
    // between a Windows host and a TypeError raised inside lease acquisition —
    // where "this host has no start id" must degrade to the pid-only decision,
    // not to a crash. No host this suite runs on selects `null`, so the platform
    // is stood in for.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    if (original === undefined) throw new Error('process.platform has no own descriptor');
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    try {
      expect(readProcessStartId(process.pid)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', original);
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
