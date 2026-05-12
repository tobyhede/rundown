import { afterEach, describe, expect, it } from '@jest/globals';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createActor } from 'xstate';
import { artifactResolveActor } from '../../../src/runbook/actors/artifact-resolve-actor.js';
import { appendArtifactManifestRecord } from '../../../src/runbook/artifact-manifest.js';
import { assertRunId, type RunId } from '../../../src/runbook/run-id.js';
import type { ArtifactVarValue } from '../../../src/runbook/types.js';

const CURRENT_RUN: RunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'tests/fixture.runbook.md' };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-resolve-actor-'));
  tempDirs.push(cwd);
  return cwd;
}

function declaration(name: string, rawToken: string | null): ArtifactDeclaration {
  return { name, rawToken };
}

async function waitForActorDone<T>(actor: ReturnType<typeof createActor>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    actor.subscribe({
      next: (snapshot) => {
        if (snapshot.status === 'done') resolve(snapshot.output as T);
        if (snapshot.status === 'error') {
          const error = snapshot.error;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      error: reject,
    });
  });
}

describe('artifactResolveActor', () => {
  it('resolves a bare-key producer declaration and writes the manifest identity', async () => {
    const cwd = await tempCwd();
    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', 'plan.json')],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    const output = await waitForActorDone<{ variables: Record<string, ArtifactVarValue> }>(actor);
    expect(output.variables.PlanPath).toMatchObject({
      kind: 'artifact-record',
      uri: `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`,
      contextId: CONTEXT_ID,
      runId: CURRENT_RUN,
      key: 'plan.json',
      runbook: RUNBOOK,
    });
  });

  it('returns an empty variables object for no declarations', async () => {
    const cwd = await tempCwd();
    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    await expect(waitForActorDone(actor)).resolves.toEqual({ variables: {} });
  });

  it('rejects when a naked declaration is unbound', async () => {
    const cwd = await tempCwd();
    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', null)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    await expect(waitForActorDone(actor)).rejects.toThrow(/unbound/i);
  });

  it('passes scopeVars into naked declaration resolution', async () => {
    const cwd = await tempCwd();
    const uri = `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`;
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      {
        kind: 'artifact-record',
        uri,
        runId: CURRENT_RUN,
        contextId: CONTEXT_ID,
        runbook: RUNBOOK,
        key: 'plan.json',
        timestamp: '2026-05-12T00:00:00.000Z',
      },
    );
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN, 'plan.json'),
      '{}',
    );

    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', null)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: { PlanPath: uri },
      },
    });

    actor.start();

    const output = await waitForActorDone<{ variables: Record<string, ArtifactVarValue> }>(actor);
    expect(output.variables.PlanPath).toMatchObject({ uri, key: 'plan.json' });
  });

  it('resolves a cross-run wildcard selector to all matching rows for the key', async () => {
    // Selector form: `rd://artifacts/<ctx>/*/<key>`. Wildcard sits on the
    // runId segment; the key remains exact. Multiple runs can have produced
    // the same key — the actor returns the array, ordered by canonical URI.
    const cwd = await tempCwd();
    const otherRun = 'rd_dddddddddddddddddddddddddddddddd';
    const uriCurrent = `rd://artifacts/${CONTEXT_ID}/${CURRENT_RUN}/plan.json`;
    const uriOther = `rd://artifacts/${CONTEXT_ID}/${otherRun}/plan.json`;
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      {
        kind: 'artifact-record',
        uri: uriCurrent,
        runId: CURRENT_RUN,
        contextId: CONTEXT_ID,
        runbook: RUNBOOK,
        key: 'plan.json',
        timestamp: '2026-05-12T00:00:00.000Z',
      },
    );
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      {
        kind: 'artifact-record',
        uri: uriOther,
        runId: otherRun,
        contextId: CONTEXT_ID,
        runbook: RUNBOOK,
        key: 'plan.json',
        timestamp: '2026-05-12T00:01:00.000Z',
      },
    );
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN), {
      recursive: true,
    });
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, otherRun), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, CURRENT_RUN, 'plan.json'),
      '{}',
    );
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, otherRun, 'plan.json'),
      '{}',
    );

    const selectorUri = `rd://artifacts/${CONTEXT_ID}/*/plan.json`;
    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('Plans', selectorUri)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    const output = await waitForActorDone<{ variables: Record<string, ArtifactVarValue> }>(actor);
    const value = output.variables.Plans;
    expect(Array.isArray(value)).toBe(true);
    if (Array.isArray(value)) {
      expect(value).toHaveLength(2);
      expect(value.map((r) => r.uri).sort()).toEqual([uriCurrent, uriOther].sort());
    }
  });

  it('resolves a cross-run exact URI literal to the existing manifest row', async () => {
    // Read-only path: the URI refers to an other-run row that already
    // exists. The actor returns the existing record verbatim.
    const cwd = await tempCwd();
    const otherRun = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const uri = `rd://artifacts/${CONTEXT_ID}/${otherRun}/plan.json`;
    await appendArtifactManifestRecord(
      { cwd, workPath: WORK_PATH },
      {
        kind: 'artifact-record',
        uri,
        runId: otherRun,
        contextId: CONTEXT_ID,
        runbook: RUNBOOK,
        key: 'plan.json',
        timestamp: '2026-05-11T00:00:00.000Z',
      },
    );
    await fsp.mkdir(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, otherRun), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, otherRun, 'plan.json'),
      '{}',
    );

    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', uri)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    const output = await waitForActorDone<{ variables: Record<string, ArtifactVarValue> }>(actor);
    expect(output.variables.PlanPath).toMatchObject({ uri, runId: otherRun, key: 'plan.json' });
  });

  it('rejects when a cross-run exact URI literal has no matching manifest row', async () => {
    // Error case: same-context cross-run URI literals MUST already exist in
    // the manifest. The resolver surfaces a clear "use a selector URI"
    // diagnostic for absence.
    const cwd = await tempCwd();
    const otherRun = 'rd_cccccccccccccccccccccccccccccccc';
    const uri = `rd://artifacts/${CONTEXT_ID}/${otherRun}/missing.json`;

    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('Missing', uri)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    await expect(waitForActorDone(actor)).rejects.toThrow(/other-run artifact|does not exist/i);
  });

  it('rejects when ensureArtifactParentDir fails on the producer surface', async () => {
    // Producer surface for a bare-key declaration calls mkdir before writing
    // the manifest row. If the artifact parent directory cannot be created
    // (here: an EEXIST-as-non-directory by pre-creating a regular file at
    // the directory path), the rejection MUST propagate so the machine can
    // stop via the typed ARTIFACT_RESOLUTION_FAILED terminal path.
    const cwd = await tempCwd();
    // Pre-create the .rd-<ctx> path as a regular FILE, not a directory.
    // mkdir({recursive:true}) on a parent under it will fail with ENOTDIR.
    await fsp.mkdir(path.join(cwd, WORK_PATH), { recursive: true });
    await fsp.writeFile(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`), 'not-a-directory');

    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', 'plan.json')],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    await expect(waitForActorDone(actor)).rejects.toThrow();
  });

  it('rejects when the manifest contains a malformed JSONL line', async () => {
    // Corrupt-manifest behaviour: the manifest reader throws a
    // line-oriented error and never returns partial results. A selector
    // declaration that depends on the manifest must therefore propagate
    // the corruption as a hard rejection (no silent fallthrough to "no
    // matches").
    const cwd = await tempCwd();
    const manifestDir = path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`);
    await fsp.mkdir(manifestDir, { recursive: true });
    await fsp.writeFile(path.join(manifestDir, 'manifest.jsonl'), 'not-a-json-line\n');

    const selectorUri = `rd://artifacts/${CONTEXT_ID}/*/plan.json`;
    const actor = createActor(artifactResolveActor, {
      input: {
        declarations: [declaration('PlanPath', selectorUri)],
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
        runId: CURRENT_RUN,
        runbook: RUNBOOK,
        scopeVars: {},
      },
    });

    actor.start();

    await expect(waitForActorDone(actor)).rejects.toThrow(/manifest|invalid/i);
  });
});
