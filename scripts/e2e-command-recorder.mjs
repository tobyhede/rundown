#!/usr/bin/env node
// e2e-command-recorder.mjs — records every `rundown` / `rd` call in the E2E container
//
// The E2E image installs this script as `rundown` and `rd` on PATH in place of
// the real bins, and keeps the real bins in a `real` directory beside it. For
// each call it runs the real CLI, passes stdin, stdout, stderr and the exit
// code through unchanged, and appends one JSON line to the command record
// (ADR 0007). Without a `real` directory it runs the next `rundown` or `rd` on
// PATH, so it also works as a directory put ahead of the real bins.
//
// Environment:
//   RUNDOWN_COMMAND_RECORD         Path of the record. Default:
//                                  <tmpdir>/rundown-command-record/commands.jsonl
//   RUNDOWN_COMMAND_RECORD_PARENT  Set by this script for the CLI it starts, to
//                                  its own entry id. A call that sees it was
//                                  made from inside another call, which is how
//                                  a runbook step command that calls `rundown`
//                                  is marked as nested.
//
// Both names match `RUNDOWN_*`, which the built-in policy passes to step
// commands, and neither matches one of its deny patterns such as `*_KEY`.
//
// Entry fields:
//   version      1
//   id           unique id of this call
//   parent_id    id of the call this one ran inside, or null
//   nested       true when parent_id is set
//   name         the name the caller used: "rundown" or "rd"
//   args         arguments, in order
//   cwd          the caller's working directory
//   started_at   ISO 8601 time the call started
//   duration_ms  whole milliseconds until the real CLI ended
//   exit_code    the exit code the caller got, or null when a signal ended the CLI
//   signal       the signal that ended the CLI, or null
//   stdout       everything the CLI wrote to stdout
//   stderr       everything the CLI wrote to stderr
//
// Things to know:
//   - An entry is appended when its call ends, so a nested entry comes before
//     the entry of the call it ran inside. Order by started_at, or follow
//     parent_id.
//   - The caller gets the CLI's bytes exactly. The record holds them decoded
//     as UTF-8, so bytes that are not valid UTF-8 are replaced in the record.
//   - The CLI's stdout and stderr are pipes, never a terminal.
//   - A call that cannot open the record does not run the CLI. It prints a
//     message and exits 125, so a gap in the record is never silent.
//   - A call killed with SIGKILL leaves no entry.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

const RECORD_ENV = 'RUNDOWN_COMMAND_RECORD';
const PARENT_ENV = 'RUNDOWN_COMMAND_RECORD_PARENT';

/** Exit code for a fault in the recorder itself. */
const RECORDER_FAULT_EXIT_CODE = 125;
/** Exit code when the real CLI is not on PATH, as a shell would report it. */
const NOT_FOUND_EXIT_CODE = 127;

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * Say whether a path is a file this process may execute.
 *
 * @param path - the path to check
 * @returns true when the path is an executable file
 */
function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the real CLI. Two places are tried, in order:
 *
 * 1. `real/<name>` beside this script. The E2E image keeps the real bins
 *    there, so the answer does not depend on PATH.
 * 2. The first executable called `name` on PATH that is not this script.
 *    Comparing resolved paths skips this script whether it was installed as a
 *    copy or as a symlink.
 *
 * @param name - the name the caller used, `rundown` or `rd`
 * @param selfPath - resolved path of this script
 * @returns the path of the real CLI, or undefined when there is none
 */
function findRealCli(name, selfPath) {
  const kept = join(dirname(selfPath), 'real', name);
  if (isExecutableFile(kept)) return kept;

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (!isExecutableFile(candidate)) continue;
    if (realpathSync(candidate) === selfPath) continue;
    return candidate;
  }
  return undefined;
}

/**
 * Copy a stream of the CLI to the caller as it arrives, and keep the bytes.
 * Stops reading while the caller's side is full. If the caller has closed its
 * side, keeps reading so the CLI can finish and the record stays complete.
 *
 * @param source - the CLI's stdout or stderr
 * @param sink - this process's stdout or stderr
 * @returns the list the chunks are collected into
 */
function forward(source, sink) {
  const chunks = [];
  let sinkOpen = true;
  sink.on('error', () => {
    sinkOpen = false;
    source.resume();
  });
  source.on('data', (chunk) => {
    chunks.push(chunk);
    if (sinkOpen && !sink.write(chunk)) {
      source.pause();
      sink.once('drain', () => source.resume());
    }
  });
  return chunks;
}

/**
 * Wait until everything written to the caller has been handed over.
 *
 * @param done - called once both streams are flushed
 */
function flushOutput(done) {
  process.stdout.write('', () => process.stderr.write('', () => done()));
}

const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const id = randomUUID();
const parentId = process.env[PARENT_ENV] || null;
const startedAt = new Date();
const startedTick = performance.now();
const recordFile =
  process.env[RECORD_ENV] || join(tmpdir(), 'rundown-command-record', 'commands.jsonl');

/**
 * Open the record for appending before the CLI runs. A call that cannot be
 * recorded must not run, so a failure here ends the process.
 *
 * @returns the open file descriptor
 */
function openRecord() {
  try {
    mkdirSync(dirname(recordFile), { recursive: true });
    return openSync(recordFile, 'a');
  } catch (error) {
    process.stderr.write(
      `rundown-command-recorder: cannot open the command record ${recordFile}: ${error.message}\n`,
    );
    process.exit(RECORDER_FAULT_EXIT_CODE);
  }
}

const recordFd = openRecord();

/**
 * Append this call's entry to the record. The line goes out in one append
 * write, so entries from calls that end at the same moment do not mix.
 *
 * @param outcome - exit_code, signal, stdout and stderr of the call
 */
function writeEntry(outcome) {
  const entry = {
    version: 1,
    id,
    parent_id: parentId,
    nested: parentId !== null,
    name,
    args,
    cwd: process.cwd(),
    started_at: startedAt.toISOString(),
    duration_ms: Math.floor(performance.now() - startedTick),
    ...outcome,
  };
  appendFileSync(recordFd, `${JSON.stringify(entry)}\n`);
  closeSync(recordFd);
}

/**
 * End the call without a CLI result: tell the caller why, and record what the
 * caller saw.
 *
 * @param message - one line for the caller's stderr
 * @param exitCode - the exit code the caller gets
 */
function endWithoutCli(message, exitCode) {
  const stderr = `rundown-command-recorder: ${message}\n`;
  process.stderr.write(stderr);
  writeEntry({ exit_code: exitCode, signal: null, stdout: '', stderr });
  process.exitCode = exitCode;
}

/**
 * Run the real CLI, pass its output through, and record the call when it ends.
 *
 * @param realCli - path of the real CLI
 */
function runRealCli(realCli) {
  const child = spawn(realCli, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, [PARENT_ENV]: id },
  });
  const stdoutChunks = forward(child.stdout, process.stdout);
  const stderrChunks = forward(child.stderr, process.stderr);

  // A signal sent to this process alone must reach the CLI. The CLI decides
  // what the signal means; this process ends the way the CLI ends.
  const forwarders = FORWARDED_SIGNALS.map((signal) => {
    const forwardSignal = () => child.kill(signal);
    process.on(signal, forwardSignal);
    return { signal, forwardSignal };
  });

  let spawnFailed = false;
  child.on('error', (error) => {
    spawnFailed = true;
    endWithoutCli(`cannot start ${realCli}: ${error.message}`, RECORDER_FAULT_EXIT_CODE);
  });

  child.on('close', (code, signal) => {
    if (spawnFailed) return;
    writeEntry({
      exit_code: code,
      signal,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    });
    if (signal === null) {
      process.exitCode = code;
      return;
    }
    // The CLI was ended by a signal. End the same way, so the caller sees the
    // signal and not an exit code. If the signal does not end this process
    // (the caller had it ignored), fall back to the shell's 128 + number.
    process.exitCode = 128 + osConstants.signals[signal];
    flushOutput(() => {
      for (const { signal: forwarded, forwardSignal } of forwarders) {
        process.off(forwarded, forwardSignal);
      }
      process.kill(process.pid, signal);
    });
  });
}

const realCli = findRealCli(name, realpathSync(process.argv[1]));
if (realCli === undefined) {
  endWithoutCli(`no real ${name} beside the recorder or on PATH`, NOT_FOUND_EXIT_CODE);
} else {
  runRealCli(realCli);
}
