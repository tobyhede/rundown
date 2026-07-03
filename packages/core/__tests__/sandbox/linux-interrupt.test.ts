import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { installInterruptForwarding } from '../../src/sandbox/linux.js';

type SignalListener = (signal: NodeJS.Signals) => void;

/** Listeners newly added to `signal` relative to the `before` snapshot. */
function addedListeners(signal: NodeJS.Signals, before: readonly unknown[]): SignalListener[] {
  return process.listeners(signal).filter((l) => !before.includes(l)) as SignalListener[];
}

describe('installInterruptForwarding', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards SIGINT to the child group, re-raises to this process, and removes its listeners', () => {
    // Mock kill so neither the (fake) child nor the test runner is actually signalled.
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const before = process.listeners('SIGINT');

    installInterruptForwarding({ pid: 4242 } as ChildProcess);
    const handlers = addedListeners('SIGINT', before);
    expect(handlers).toHaveLength(1);

    // Invoke the installed handler directly (not process.emit) to avoid touching
    // any other SIGINT listeners the runtime may have.
    handlers[0]('SIGINT');

    // Negative pid targets the whole detached group; then re-raise to self.
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGINT');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
    // The handler removed itself as part of re-raising, so nothing leaks.
    expect(process.listeners('SIGINT')).not.toContain(handlers[0]);
  });

  it('forwards SIGTERM the same way (Rundown must stay killable while a command runs)', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const before = process.listeners('SIGTERM');

    installInterruptForwarding({ pid: 777 } as ChildProcess);
    const handlers = addedListeners('SIGTERM', before);
    expect(handlers).toHaveLength(1);

    handlers[0]('SIGTERM');

    expect(killSpy).toHaveBeenCalledWith(-777, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(process.listeners('SIGTERM')).not.toContain(handlers[0]);
  });

  it('cleanup() removes both listeners without signalling anything', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');

    const cleanup = installInterruptForwarding({ pid: 1 } as ChildProcess);
    expect(addedListeners('SIGINT', beforeInt)).toHaveLength(1);
    expect(addedListeners('SIGTERM', beforeTerm)).toHaveLength(1);

    cleanup();

    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('still re-raises to this process when the child has no pid (no group to signal)', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const before = process.listeners('SIGINT');

    installInterruptForwarding({ pid: undefined } as unknown as ChildProcess);
    const handlers = addedListeners('SIGINT', before);

    handlers[0]('SIGINT');

    // No group kill (no valid pid), but the process is still re-raised so its
    // default disposition runs.
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
  });
});
