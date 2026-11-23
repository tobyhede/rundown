import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const recorderScript = fileURLToPath(new URL('../e2e-command-recorder.mjs', import.meta.url));

/**
 * Stub for the real CLI. The first argument picks what it does, so each test
 * states the output and exit code it expects the recorder to pass through.
 */
const STUB_CLI = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const [mode, ...rest] = process.argv.slice(2);
if (mode === 'emit') {
  process.stdout.write(rest[0]);
  process.stderr.write(rest[1]);
  process.exitCode = Number(rest[2]);
} else if (mode === 'cat') {
  process.stdin.pipe(process.stdout);
} else if (mode === 'args') {
  process.stdout.write(JSON.stringify(rest));
} else if (mode === 'bytes') {
  process.stdout.write(Buffer.from(rest[0], 'hex'));
} else if (mode === 'step') {
  // Stands in for a runbook step command: a shell that calls the CLI by name,
  // with only the variables the built-in policy would pass (PATH, HOME, RUNDOWN_*).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|HOME|RUNDOWN_.*)$/.test(key)),
  );
  const step = spawnSync('sh', ['-c', rest[0]], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write('step:' + step.stdout.toString());
  process.exitCode = step.status;
} else if (mode === 'die') {
  process.stdout.write('before signal');
  process.kill(process.pid, rest[0]);
} else if (mode === 'wait') {
  // The handler goes in before "ready" is printed. A caller that signals on
  // "ready" must never reach a process that still has the default action.
  process.on('SIGTERM', () => {
    process.stdout.write('got SIGTERM');
    process.exit(7);
  });
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
}
`;

/**
 * Build a sandbox directory holding the recorder under both CLI names, ahead
 * of a stub CLI on PATH.
 *
 * @param t - the node:test context, used to remove the sandbox afterwards
 * @returns the environment to run commands with, the record path and the sandbox directories
 */
async function setupSandbox(t) {
  const work = await mkdtemp(join(tmpdir(), 'e2e-command-recorder-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const recorderBin = join(work, 'recorder-bin');
  const realBin = join(work, 'real-bin');
  await mkdir(recorderBin);
  await mkdir(realBin);

  for (const name of ['rundown', 'rd']) {
    await symlink(recorderScript, join(recorderBin, name));
    await writeFile(join(realBin, name), STUB_CLI);
    await chmod(join(realBin, name), 0o755);
  }

  const recordFile = join(work, 'record', 'commands.jsonl');
  const env = {
    PATH: `${recorderBin}:${realBin}:${process.env.PATH}`,
    HOME: work,
    RUNDOWN_COMMAND_RECORD: recordFile,
  };
  return { work, recorderBin, realBin, recordFile, env };
}

/**
 * Read the command record as parsed entries, one per line.
 *
 * @param recordFile - path of the JSONL command record
 * @returns the parsed entries in file order
 */
async function readRecord(recordFile) {
  const text = await readFile(recordFile, 'utf-8');
  assert.ok(text.endsWith('\n'), 'the record must end with a newline');
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('passes stdout, stderr and exit code through and records the call', async (t) => {
  const { work, recordFile, env } = await setupSandbox(t);

  const before = Date.now();
  const result = spawnSync('rundown', ['emit', 'out text\n', 'err text\n', '0'], {
    env,
    cwd: work,
    encoding: 'utf-8',
  });
  const after = Date.now();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out text\n');
  assert.equal(result.stderr, 'err text\n');

  const entries = await readRecord(recordFile);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.version, 1);
  assert.equal(entry.name, 'rundown');
  assert.deepEqual(entry.args, ['emit', 'out text\n', 'err text\n', '0']);
  assert.equal(entry.stdout, 'out text\n');
  assert.equal(entry.stderr, 'err text\n');
  assert.equal(entry.exit_code, 0);
  assert.equal(entry.signal, null);
  assert.equal(entry.nested, false);
  assert.equal(entry.parent_id, null);
  assert.equal(typeof entry.id, 'string');
  // macOS reports the temp directory through a /private symlink.
  assert.ok(entry.cwd.endsWith(work), `cwd ${entry.cwd} must be the caller's directory`);

  const startedAt = Date.parse(entry.started_at);
  assert.ok(startedAt >= before && startedAt <= after, 'started_at must fall inside the call');
  assert.ok(Number.isInteger(entry.duration_ms) && entry.duration_ms >= 0);
  assert.ok(entry.duration_ms <= after - before, 'duration_ms must not exceed the call');
});

test('passes a non-zero exit code through and records it', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const result = spawnSync('rundown', ['emit', '{"type":"error"}\n', 'refused\n', '3'], {
    env,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 3);
  assert.equal(result.stdout, '{"type":"error"}\n');
  assert.equal(result.stderr, 'refused\n');

  const [entry] = await readRecord(recordFile);
  assert.equal(entry.exit_code, 3);
  assert.equal(entry.stdout, '{"type":"error"}\n');
  assert.equal(entry.stderr, 'refused\n');
});

test('records a call made under the rd name and runs the real rd', async (t) => {
  const { realBin, recordFile, env } = await setupSandbox(t);
  // Give the two real bins different output, so the test shows which one ran.
  await writeFile(join(realBin, 'rd'), '#!/bin/sh\nprintf "real rd: %s" "$1"\nexit 4\n');

  const result = spawnSync('rd', ['status'], { env, encoding: 'utf-8' });

  assert.equal(result.status, 4);
  assert.equal(result.stdout, 'real rd: status');

  const entries = await readRecord(recordFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'rd');
  assert.deepEqual(entries[0].args, ['status']);
  assert.equal(entries[0].stdout, 'real rd: status');
  assert.equal(entries[0].exit_code, 4);
});

test('marks a call made from a step command as nested inside the outer call', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const result = spawnSync('rundown', ['step', 'rd emit inner "" 5'], { env, encoding: 'utf-8' });

  assert.equal(result.status, 5);
  assert.equal(result.stdout, 'step:inner');

  const entries = await readRecord(recordFile);
  assert.equal(entries.length, 2);
  const outer = entries.find((entry) => entry.name === 'rundown');
  const inner = entries.find((entry) => entry.name === 'rd');

  assert.equal(outer.nested, false);
  assert.equal(outer.parent_id, null);
  assert.equal(outer.stdout, 'step:inner');
  assert.equal(outer.exit_code, 5);

  assert.equal(inner.nested, true);
  assert.equal(inner.parent_id, outer.id);
  assert.deepEqual(inner.args, ['emit', 'inner', '', '5']);
  assert.equal(inner.stdout, 'inner');
  assert.equal(inner.exit_code, 5);
});

test('passes stdin through to the real CLI', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const result = spawnSync('rundown', ['cat'], {
    env,
    input: 'line one\nline two\n',
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'line one\nline two\n');
  const [entry] = await readRecord(recordFile);
  assert.equal(entry.stdout, 'line one\nline two\n');
});

test('keeps arguments with spaces, quotes, newlines and empty strings intact', async (t) => {
  const { recordFile, env } = await setupSandbox(t);
  const awkward = ['two words', 'line\nbreak', '', '"quoted" \'single\'', '--input=a=b', 'café ✓'];

  const result = spawnSync('rundown', ['args', ...awkward], { env, encoding: 'utf-8' });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), awkward);
  const [entry] = await readRecord(recordFile);
  assert.deepEqual(entry.args, ['args', ...awkward]);
});

test('gives the caller bytes that are not valid UTF-8 exactly as written', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const result = spawnSync('rundown', ['bytes', 'ff00fe41'], { env });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString('hex'), 'ff00fe41');
  // The record is JSON text, so it holds the lossy UTF-8 decoding.
  const [entry] = await readRecord(recordFile);
  assert.equal(entry.stdout, '�\u0000�A');
});

test('appends whole lines when many calls end at the same time', async (t) => {
  const { recordFile, env } = await setupSandbox(t);
  const callCount = 24;
  // Larger than a pipe buffer, so a torn write would show up as a broken line.
  const payloadFor = (index) => String(index % 10).repeat(200_000);

  const exitCodes = await Promise.all(
    Array.from({ length: callCount }, (_, index) => {
      return new Promise((resolve, reject) => {
        const child = spawn('rundown', ['emit', payloadFor(index), `call ${index}`, '0'], {
          env,
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('close', resolve);
      });
    }),
  );
  assert.deepEqual(exitCodes, Array(callCount).fill(0));

  const entries = await readRecord(recordFile);
  assert.equal(entries.length, callCount);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, callCount);
  for (let index = 0; index < callCount; index++) {
    const entry = entries.find((candidate) => candidate.stderr === `call ${index}`);
    assert.ok(entry, `call ${index} must have an entry`);
    assert.equal(entry.stdout, payloadFor(index));
  }
});

test('ends with the same signal when a signal ends the real CLI', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const result = spawnSync('rundown', ['die', 'SIGTERM'], { env, encoding: 'utf-8' });

  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
  assert.equal(result.stdout, 'before signal');

  const [entry] = await readRecord(recordFile);
  assert.equal(entry.exit_code, null);
  assert.equal(entry.signal, 'SIGTERM');
  assert.equal(entry.stdout, 'before signal');
});

test('forwards a signal sent to the recorder to the real CLI', async (t) => {
  const { recordFile, env } = await setupSandbox(t);

  const child = spawn('rundown', ['wait'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  const closed = new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    // The stub prints "ready" once its SIGTERM handler is in place.
    if (stdout === '') child.kill('SIGTERM');
    stdout += chunk;
  });

  assert.deepEqual(await closed, { code: 7, signal: null });
  assert.equal(stdout, 'ready\ngot SIGTERM');

  const [entry] = await readRecord(recordFile);
  assert.equal(entry.exit_code, 7);
  assert.equal(entry.stdout, 'ready\ngot SIGTERM');
});

test('does not run the CLI when the record cannot be opened', async (t) => {
  const { work, env } = await setupSandbox(t);
  // A file where the record's directory should be makes the record unopenable.
  const blocker = join(work, 'blocker');
  await writeFile(blocker, '');
  const marker = join(work, 'cli-ran');

  const result = spawnSync('rundown', ['step', `touch ${marker}`], {
    env: { ...env, RUNDOWN_COMMAND_RECORD: join(blocker, 'commands.jsonl') },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 125);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^rundown-command-recorder: cannot open the command record /);
  await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'the real CLI must not have run');
});

test('reports and records a call when there is no real CLI', async (t) => {
  const { recorderBin, recordFile, env } = await setupSandbox(t);
  const nodeDir = join(process.execPath, '..');

  const result = spawnSync(join(recorderBin, 'rundown'), ['status'], {
    env: { ...env, PATH: `${recorderBin}:${nodeDir}` },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 127);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'rundown-command-recorder: no real rundown beside the recorder or on PATH\n',
  );

  const [entry] = await readRecord(recordFile);
  assert.equal(entry.exit_code, 127);
  assert.equal(entry.stderr, result.stderr);
  assert.deepEqual(entry.args, ['status']);
});

test('writes to a record under the temp directory when no path is given', async (t) => {
  const { work, env } = await setupSandbox(t);
  const { RUNDOWN_COMMAND_RECORD: _unset, ...envWithoutRecord } = env;

  const result = spawnSync('rundown', ['emit', 'out', '', '0'], {
    env: { ...envWithoutRecord, TMPDIR: work },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0);
  const [entry] = await readRecord(join(work, 'rundown-command-record', 'commands.jsonl'));
  assert.equal(entry.stdout, 'out');
});

test('runs the real CLI kept beside the recorder when PATH holds only the recorder', async (t) => {
  // The image layout: the recorder takes the CLI's place on PATH, and the real
  // bins sit in a `real` directory next to the installed script. A login shell
  // that resets PATH cannot take the recorder out of the way.
  const { work, recordFile, env } = await setupSandbox(t);
  const installDir = join(work, 'install');
  const pathDir = join(work, 'path-bin');
  await mkdir(join(installDir, 'real'), { recursive: true });
  await mkdir(pathDir);
  await copyFile(recorderScript, join(installDir, 'e2e-command-recorder.mjs'));
  await writeFile(join(installDir, 'real', 'rd'), '#!/bin/sh\nprintf "kept rd: %s" "$1"\nexit 6\n');
  await chmod(join(installDir, 'real', 'rd'), 0o755);
  await symlink(join(installDir, 'e2e-command-recorder.mjs'), join(pathDir, 'rd'));
  const nodeDir = join(process.execPath, '..');

  const result = spawnSync('rd', ['status'], {
    env: { ...env, PATH: `${pathDir}:${nodeDir}:/usr/bin:/bin` },
    encoding: 'utf-8',
  });

  assert.equal(result.stderr, '');
  assert.equal(result.status, 6);
  assert.equal(result.stdout, 'kept rd: status');
  const [entry] = await readRecord(recordFile);
  assert.equal(entry.name, 'rd');
  assert.equal(entry.exit_code, 6);
});
