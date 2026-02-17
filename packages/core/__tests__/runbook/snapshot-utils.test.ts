import { describe, it, expect } from '@jest/globals';
import {
  isRunbookComplete,
  isRunbookStopped,
  asTerminalSnapshot,
  asTerminalSnapshotOrDefault,
} from '../../src/runbook/snapshot-utils.js';

describe('isRunbookComplete', () => {
  it('returns true for done+COMPLETE', () => {
    expect(isRunbookComplete({ status: 'done', value: 'COMPLETE' })).toBe(true);
  });

  it('returns false for done+STOPPED', () => {
    expect(isRunbookComplete({ status: 'done', value: 'STOPPED' })).toBe(false);
  });

  it('returns false for active status', () => {
    expect(isRunbookComplete({ status: 'active', value: undefined })).toBe(false);
  });

  it('returns false for done with other value', () => {
    expect(isRunbookComplete({ status: 'done', value: 'OTHER' })).toBe(false);
  });
});

describe('isRunbookStopped', () => {
  it('returns true for done+STOPPED', () => {
    expect(isRunbookStopped({ status: 'done', value: 'STOPPED' })).toBe(true);
  });

  it('returns false for done+COMPLETE', () => {
    expect(isRunbookStopped({ status: 'done', value: 'COMPLETE' })).toBe(false);
  });

  it('returns false for active status', () => {
    expect(isRunbookStopped({ status: 'active', value: undefined })).toBe(false);
  });
});

describe('asTerminalSnapshot', () => {
  it('returns snapshot for valid object with status and value', () => {
    const snapshot = { status: 'done', value: 'COMPLETE' };
    expect(asTerminalSnapshot(snapshot)).toBe(snapshot);
  });

  it('returns null for null', () => {
    expect(asTerminalSnapshot(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asTerminalSnapshot(undefined)).toBeNull();
  });

  it('returns null for primitive string', () => {
    expect(asTerminalSnapshot('hello')).toBeNull();
  });

  it('returns null for primitive number', () => {
    expect(asTerminalSnapshot(42)).toBeNull();
  });

  it('returns null for object missing status field', () => {
    expect(asTerminalSnapshot({ value: 'COMPLETE' })).toBeNull();
  });

  it('returns null for object missing value field', () => {
    expect(asTerminalSnapshot({ status: 'done' })).toBeNull();
  });

  it('returns null when status is not a string', () => {
    expect(asTerminalSnapshot({ status: 42, value: 'COMPLETE' })).toBeNull();
  });
});

describe('asTerminalSnapshotOrDefault', () => {
  it('returns snapshot for valid object', () => {
    const snapshot = { status: 'done', value: 'COMPLETE' };
    expect(asTerminalSnapshotOrDefault(snapshot)).toBe(snapshot);
  });

  it('returns active default for null', () => {
    expect(asTerminalSnapshotOrDefault(null)).toEqual({ status: 'active', value: undefined });
  });

  it('returns active default for undefined', () => {
    expect(asTerminalSnapshotOrDefault(undefined)).toEqual({ status: 'active', value: undefined });
  });

  it('returns active default for invalid object', () => {
    expect(asTerminalSnapshotOrDefault({ foo: 'bar' })).toEqual({
      status: 'active',
      value: undefined,
    });
  });
});
