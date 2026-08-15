/**
 * Ownership of an inline-launch latch: who is launching this child, and are
 * they still alive?
 *
 * The latch (`substepStates[].inline.started`) is the durable record that makes
 * an inline launch exactly-once — it is committed BEFORE the child run is
 * created, so two observers of one intent cannot both reach `manager.create`
 * for the intent's fixed child run id. Committing first opens a window: a
 * process that dies between the latch and the create leaves the launch latched
 * with no child, and without liveness every later observer stands down forever.
 *
 * The file lock this latch replaced never had that problem — a crashed holder
 * was reclaimed by the next acquirer through a PID-aware staleness check. This
 * module gives the latch the same property, on the same terms the file locks
 * state: reclamation is **never** age-based, only ever a proof that the owner is
 * gone. See `runbook/process-identity` for why that proof needs a start id
 * rather than a bare pid.
 *
 * Absence of the child run row is deliberately NOT the signal. An observer that
 * has latched and is still resolving the child runbook presents exactly the same
 * state as a crashed one, so reclaiming on absence would send both into
 * `manager.create` and reproduce the race the latch exists to prevent. Liveness
 * is the only thing that separates *dead* from *not there yet*.
 *
 * A pid is meaningful on one host, so this inherits the single-host assumption
 * the execution lease and the file locks already make: a store reached from two
 * machines can read a foreign pid as absent. That is the same exposure those
 * mechanisms carry, not a new one this module introduces.
 *
 * @module runbook/inline-launch-start
 */

import { isOwnerAlive, sharedProcessIdentity, type ProcessIdentity } from './process-identity.js';
import type { InlineLaunchStart } from './types.js';

/**
 * What a latch record says about the launch it stands for.
 *
 * Three states, and only `unlatched` and `reclaimable` may proceed into the
 * launch span — a caller must narrow rather than test a boolean, because the
 * two that may proceed differ in what they should tell the operator.
 */
export type InlineLaunchOwnership =
  /** No launch has been latched; this observer may take it. */
  | { readonly kind: 'unlatched' }
  /** A live process owns the launch; nobody else may enter the span. */
  | { readonly kind: 'held'; readonly ownerPid: number }
  /** The owner is provably gone; this observer may take the launch over. */
  | { readonly kind: 'reclaimable'; readonly ownerPid: number };

/**
 * Decide whether an inline launch may be entered, and on what grounds.
 *
 * The bias is one-directional and deliberate, inherited from
 * {@link isOwnerAlive}: every unknown answers "alive", so an unreadable start id
 * or a host that supplies none degrades to the pid-only decision. A false
 * `held` stalls a launch that the next observation re-examines; a false
 * `reclaimable` sends a second process into a launch span another process is
 * already executing, which is the duplicate `INSERT INTO runs` the latch exists
 * to prevent.
 *
 * Pure over its input except for the liveness syscall — a `kill(pid, 0)` read,
 * no different in kind from the loads that already sit inside a compare-and-swap
 * build callback, which is what makes this callable from inside one.
 *
 * @param started - The latch record read from the parent's substep state, or
 *   null when no launch has been latched.
 * @param identity - Start-identity source for the recorded pid; defaults to the
 *   process-wide identity so the BSD `ps` probe is paid at most once.
 * @returns The ownership classification; callers must narrow before launching.
 */
export function classifyInlineLaunchOwnership(
  started: InlineLaunchStart | null,
  identity: ProcessIdentity = sharedProcessIdentity(),
): InlineLaunchOwnership {
  if (started === null) return { kind: 'unlatched' };
  return isOwnerAlive(identity, started.ownerPid, started.ownerStartId)
    ? { kind: 'held', ownerPid: started.ownerPid }
    : { kind: 'reclaimable', ownerPid: started.ownerPid };
}

/**
 * Build the latch record this process writes when it wins a launch.
 *
 * The start id is read HERE, through the same {@link ProcessIdentity} that
 * {@link classifyInlineLaunchOwnership} reads it back with. That is not
 * incidental: start-id formats are per-platform and per-derivation, so a value
 * written by one derivation and compared by another would never match — and a
 * mismatch is read as proof of death.
 *
 * @param at - ISO 8601 instant the launch was latched.
 * @param identity - Start-identity source; defaults to the process-wide identity.
 * @param ownerPid - Pid to record as the owner; defaults to this process.
 * @returns The record to commit alongside the launch.
 */
export function recordInlineLaunchStart(
  at: string,
  identity: ProcessIdentity = sharedProcessIdentity(),
  ownerPid: number = process.pid,
): InlineLaunchStart {
  return { at, ownerPid, ownerStartId: identity.of(ownerPid) };
}
