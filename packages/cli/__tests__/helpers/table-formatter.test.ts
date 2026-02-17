import { describe, it, expect, jest } from '@jest/globals';
import { formatTable, printTable } from '../../src/helpers/table-formatter.js';
import type { Column } from '../../src/helpers/table-formatter.js';

describe('formatTable', () => {
  it('returns header + data lines', () => {
    const rows = [{ name: 'foo', desc: 'A foo' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'Name', key: 'name' },
      { header: 'Description', key: 'desc' },
    ];

    const lines = formatTable(rows, columns);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('DESCRIPTION');
    expect(lines[1]).toContain('foo');
    expect(lines[1]).toContain('A foo');
  });

  it('uppercases headers', () => {
    const lines = formatTable([], [{ header: 'myHeader' }]);
    expect(lines[0]).toBe('MYHEADER');
  });

  it('uses 2-space default separator', () => {
    const rows = [{ a: 'x', b: 'y' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'A', key: 'a' },
      { header: 'B', key: 'b' },
    ];
    const lines = formatTable(rows, columns);
    // Header 'A' padded to max width, then 2-space sep, then 'B'
    expect(lines[0]).toMatch(/A\s{2,}B/);
  });

  it('pads columns to max width of header vs data', () => {
    const rows = [{ name: 'longvalue', x: '1' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'N', key: 'name' },
      { header: 'X', key: 'x' },
    ];
    const lines = formatTable(rows, columns);
    // Header 'N' should be padded to width of 'longvalue' (9)
    expect(lines[0]).toMatch(/^N {8} {2}X$/);
  });

  it('does not pad last column', () => {
    const rows = [{ a: 'short', b: 'val' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'A', key: 'a' },
      { header: 'B', key: 'b' },
    ];
    const lines = formatTable(rows, columns);
    // Last column should not have trailing spaces
    expect(lines[1]).not.toMatch(/val\s+$/);
  });

  it('uses key-based value extraction', () => {
    const rows = [{ myKey: 'hello' }];
    const columns: Column<(typeof rows)[0]>[] = [{ header: 'Col', key: 'myKey' }];
    const lines = formatTable(rows, columns);
    expect(lines[1]).toBe('hello');
  });

  it('uses function-based extraction via get', () => {
    const rows = [{ first: 'John', last: 'Doe' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'Full', get: (row) => `${row.first} ${row.last}` },
    ];
    const lines = formatTable(rows, columns);
    expect(lines[1]).toBe('John Doe');
  });

  it('returns empty string for missing key and get', () => {
    const rows = [{ a: 'x' }];
    const columns: Column<(typeof rows)[0]>[] = [{ header: 'Col' }];
    const lines = formatTable(rows, columns);
    expect(lines[1]).toBe('');
  });

  it('converts null/undefined values to empty string', () => {
    const rows = [{ a: null, b: undefined }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'A', get: (row) => row.a },
      { header: 'B', get: (row) => row.b },
    ];
    const lines = formatTable(rows, columns);
    // Both values should be empty, not 'null' or 'undefined'
    expect(lines[1]).not.toContain('null');
    expect(lines[1]).not.toContain('undefined');
  });

  it('supports right alignment', () => {
    const rows = [{ n: '42' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'Number', key: 'n', align: 'right' },
      { header: 'End' },
    ];
    const lines = formatTable(rows, columns);
    // '42' should be right-aligned within the column width of 'NUMBER' (6)
    expect(lines[1]).toMatch(/\s+42/);
  });

  it('supports custom separator', () => {
    const rows = [{ a: 'x', b: 'y' }];
    const columns: Column<(typeof rows)[0]>[] = [
      { header: 'A', key: 'a' },
      { header: 'B', key: 'b' },
    ];
    const lines = formatTable(rows, columns, { separator: ' | ' });
    expect(lines[0]).toContain(' | ');
  });

  it('returns header only for empty rows', () => {
    const columns: Column<Record<string, unknown>>[] = [{ header: 'Name' }, { header: 'Status' }];
    const lines = formatTable([], columns);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME');
  });

  it('handles single column single row', () => {
    const rows = [{ val: 'only' }];
    const columns: Column<(typeof rows)[0]>[] = [{ header: 'Value', key: 'val' }];
    const lines = formatTable(rows, columns);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('VALUE');
    expect(lines[1]).toBe('only');
  });
});

describe('printTable', () => {
  it('calls console.log for each formatted line', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const rows = [{ a: '1' }, { a: '2' }];
    const columns: Column<(typeof rows)[0]>[] = [{ header: 'A', key: 'a' }];

    printTable(rows, columns);

    // 1 header + 2 data = 3 lines
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
