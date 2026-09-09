import { existsSync, renameSync, writeFileSync } from 'node:fs';
import {
  ExecutionEventEmitter,
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  activateRunProgression,
  assertClaimId,
  createEffectfulActorMutationRunner,
  getErrorMessage,
  type TerminalPropagationSource,
} from '@rundown-org/core';
import { readLifecycleCallerEvidence } from '../../src/helpers/caller-evidence.js';
import { buildNonDelegatingLifecycleSeam } from '../../src/helpers/lifecycle-seam-factory.js';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import { createCliCommandServices } from '../../src/services/execution.js';

const BARRIER_TIMEOUT_MS = 60_000;
const [cwd, runId, claimIdValue, barrierIntent, readyFile, goFile, reportFile] =
  process.argv.slice(2);

if (
  !cwd ||
  !runId ||
  !claimIdValue ||
  (barrierIntent !== 'waiting' && barrierIntent !== 'apply_completion') ||
  !readyFile ||
  !goFile ||
  !reportFile
) {
  throw new Error('progression-completion-race-driver-child: invalid protocol arguments');
}

const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Park this process at a deterministic synchronous machine-selection boundary. */
function awaitBarrier(): void {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(goFile)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`progression-completion-race-driver-child: timed out waiting for ${goFile}`);
    }
    Atomics.wait(waitCell, 0, 0, Math.min(remaining, 10));
  }
}

/** Publish a complete report atomically so the parent never reads partial JSON. */
function publish(report: unknown): void {
  const staging = `${reportFile}.partial`;
  writeFileSync(staging, JSON.stringify(report));
  renameSync(staging, reportFile);
}

class SelectionBarrierActorService extends RunbookActorService {
  private parked = false;

  override async selectRunProgressionIntent(
    ...args: Parameters<RunbookActorService['selectRunProgressionIntent']>
  ): ReturnType<RunbookActorService['selectRunProgressionIntent']> {
    const intent = await super.selectRunProgressionIntent(...args);
    if (!this.parked && intent.kind === barrierIntent) {
      this.parked = true;
      writeFileSync(readyFile, String(process.pid));
      awaitBarrier();
    }
    return intent;
  }
}

const manager = new RunbookStateManager(cwd);
const actorService = new SelectionBarrierActorService(manager, {
  commandServices: createCliCommandServices(),
});

try {
  const claimId = assertClaimId(claimIdValue);
  // Record the first substep's PASS through the real lifecycle seam. The
  // returned opaque directive supplies the verified authority used below; the
  // fixture never mints or reconstructs authority itself.
  const { seam } = buildNonDelegatingLifecycleSeam(cwd);
  const ingress = await seam.runTransition({
    command: 'pass',
    callerEvidence: readLifecycleCallerEvidence({ claimId }),
    targetSelector: { kind: 'claim', claimId },
    terminalPolicy: { releaseOnTerminal: true },
  });
  if (ingress.kind !== 'applied' || ingress.progression.kind !== 'activate') {
    throw new Error(
      `progression-completion-race-driver-child: PASS ingress did not activate: ${JSON.stringify(ingress)}`,
    );
  }

  const state = await manager.load(runId);
  if (!state) {
    throw new Error(`progression-completion-race-driver-child: run ${runId} is missing`);
  }
  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  const events: string[] = [];
  emitter.subscribe((event) => events.push(event.type));
  for (const event of ingress.events) emitter.emit(event);
  const propagationSources: TerminalPropagationSource[] = [];

  const outcome = await activateRunProgression(
    ingress.progression.authority,
    {
      manager,
      actorService,
      sessionService: new SessionService(manager),
      actorMutationRunner: createEffectfulActorMutationRunner(cwd),
      loadSteps: (loaded) => getRunbookFromState(loaded, cwd),
      sink: emitter,
      dispatchInlineChild: async () => ({ kind: 'waiting' }),
      propagateTerminal: async ({ source }) => {
        propagationSources.push(source);
        return { kind: 'propagated' };
      },
    },
    ingress.progression.entryBoundary,
  );
  publish({ ok: true, pid: process.pid, outcome, events, propagationSources });
} catch (error: unknown) {
  publish({ ok: false, pid: process.pid, error: getErrorMessage(error) });
  process.exitCode = 1;
}
