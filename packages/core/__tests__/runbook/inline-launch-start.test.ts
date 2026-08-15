import { describe, it, expect } from '@jest/globals';
import {
  classifyInlineLaunchOwnership,
  recordInlineLaunchStart,
} from '../../src/runbook/inline-launch-start.js';
import { createProcessIdentity, readProcessStartId } from '../../src/runbook/process-identity.js';
import type { InlineLaunchStart } from '../../src/runbook/types.js';

/**
 * A pid that can never be alive: above every platform's pid_max (Linux 4194304,
 * macOS 99998), so `kill(pid, 0)` is always ESRCH.
 *
 * A spawned-and-reaped pid is only dead until the OS recycles it. The same
 * constant is used by the process-identity, lease and file-lock suites.
 */
const DEAD_PID = 999999999;

/**
 * Whether this host actually supplies a start id, probed rather than assumed.
 *
 * A sandbox that denies `/proc` or the `ps` spawn is a supported host on which
 * every read answers `null`, which is correct behaviour and would turn the
 * live-host case below into a failure if it were gated on `process.platform`.
 */
const HOST_HAS_START_IDS = readProcessStartId(process.pid) !== null;

/** A start record for `pid`, carrying `startId` as the recorded owner identity. */
function startedBy(pid: number, startId: string | null): InlineLaunchStart {
  return { at: '2026-08-14T00:00:00.000Z', ownerPid: pid, ownerStartId: startId };
}

describe('classifyInlineLaunchOwnership', () => {
  // The unlatched arm is what the whole compare-and-latch turns on: it is the
  // only classification that lets an observer write the latch, so it must be
  // reachable from exactly one state — no record at all.
  it('reports an absent record as unlatched', () => {
    expect(classifyInlineLaunchOwnership(null)).toEqual({ kind: 'unlatched' });
  });

  // The property #690 dropped and this classifier buys back. A pid above
  // pid_max is dead on every host, whatever it can say about start ids, so this
  // arm is the one that does not depend on the platform answering at all.
  it('reports a record whose owner pid is gone as reclaimable', () => {
    expect(classifyInlineLaunchOwnership(startedBy(DEAD_PID, null))).toEqual({
      kind: 'reclaimable',
      ownerPid: DEAD_PID,
    });
  });

  // The safety arm, driven against a process that is definitely running: this
  // one. A false `reclaimable` here is the `SQLITE_CONSTRAINT` race the latch
  // exists to prevent, so it is asserted against a real liveness probe rather
  // than a double.
  it('reports this process as holding its own latch', () => {
    const started = startedBy(process.pid, readProcessStartId(process.pid));

    expect(classifyInlineLaunchOwnership(started)).toEqual({
      kind: 'held',
      ownerPid: process.pid,
    });
  });

  // Why a start id, and not a bare pid: a recycled pid is alive and is NOT the
  // owner. Only an injected identity can model this — the recorded id has to
  // disagree with the observed one for a pid that genuinely exists.
  it('reports a recycled owner pid as reclaimable even though the pid is alive', () => {
    const identity = createProcessIdentity(() => 'observed-start-id');

    expect(
      classifyInlineLaunchOwnership(startedBy(process.pid, 'recorded-start-id'), identity),
    ).toEqual({ kind: 'reclaimable', ownerPid: process.pid });
  });

  // Both unknown-arms of the pid-only decision, which must err towards `held`:
  // a false `reclaimable` hands a second process a launch someone else is
  // performing, while a false `held` only stalls a launch the next observation
  // re-examines.
  it.each<{ readonly name: string; readonly recorded: string | null; readonly observed: string }>([
    { name: 'the record carries no start id', recorded: null, observed: 'observed-start-id' },
    { name: 'the host cannot read one now', recorded: 'recorded-start-id', observed: '' },
  ])('reports a live owner pid as held when $name', ({ recorded, observed }) => {
    const identity = createProcessIdentity(() => (observed === '' ? null : observed));

    expect(classifyInlineLaunchOwnership(startedBy(process.pid, recorded), identity)).toEqual({
      kind: 'held',
      ownerPid: process.pid,
    });
  });
});

describe('recordInlineLaunchStart', () => {
  it('records the supplied instant with this process as the owner', () => {
    const at = '2026-08-14T01:02:03.456Z';

    const started = recordInlineLaunchStart(at);

    expect(started).toEqual({
      at,
      ownerPid: process.pid,
      ownerStartId: readProcessStartId(process.pid),
    });
    // The recorded id is the one THIS host reads, so a host that supplies none
    // records `null` rather than a placeholder that a later read could match.
    expect(started.ownerStartId === null).toBe(!HOST_HAS_START_IDS);
  });

  // The round trip is the contract: what this function writes must classify as
  // `held` when read back by a live process, or the latch would reclaim itself.
  it('produces a record that classifies as held while this process runs', () => {
    expect(
      classifyInlineLaunchOwnership(recordInlineLaunchStart('2026-08-14T00:00:00.000Z')),
    ).toEqual({ kind: 'held', ownerPid: process.pid });
  });

  it('records the injected owner and identity when both are supplied', () => {
    const identity = createProcessIdentity(() => 'synthetic-start-id');

    expect(recordInlineLaunchStart('2026-08-14T00:00:00.000Z', identity, DEAD_PID)).toEqual({
      at: '2026-08-14T00:00:00.000Z',
      ownerPid: DEAD_PID,
      ownerStartId: 'synthetic-start-id',
    });
  });
});
