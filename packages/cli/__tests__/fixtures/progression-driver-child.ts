import { existsSync, renameSync, writeFileSync } from 'node:fs';
import {
  ExecutionEventEmitter,
  RunbookStateManager,
  SessionService,
  activateRunProgression,
  assertClaimId,
  createEffectfulActorMutationRunner,
  getErrorMessage,
  type ActorSyncResult,
  type EffectfulActorMutationRunner,
  type EffectfulActorMutationRunnerInput,
  type EffectfulActorMutationSetRunnerInput,
  type EffectfulActorMutationSetRunnerResult,
  type GuardedMutationResult,
  type PreEffectActorMutationReturn,
  type PreflightEffectfulActorMutationRunnerInput,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../../src/helpers/actor-service-factory.js';
import { readLifecycleCallerEvidence } from '../../src/helpers/caller-evidence.js';
import { buildNonDelegatingLifecycleSeam } from '../../src/helpers/lifecycle-seam-factory.js';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import { createCliCommandServices } from '../../src/services/execution.js';

const BARRIER_TIMEOUT_MS = 60_000;
const [cwd, runId, claimIdValue, readyFile, goFile, reportFile] = process.argv.slice(2);

if (!cwd || !runId || !claimIdValue || !readyFile || !goFile || !reportFile) {
  throw new Error('progression-driver-child: missing protocol argument');
}

/** Wait for the writer-completed barrier without establishing order by elapsed time. */
async function awaitBarrier(): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!existsSync(goFile)) {
    if (Date.now() >= deadline) {
      throw new Error(`progression-driver-child: timed out waiting for ${goFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Publish a complete report atomically so the parent never observes partial JSON. */
function publish(report: unknown): void {
  const staging = `${reportFile}.partial`;
  writeFileSync(staging, JSON.stringify(report));
  renameSync(staging, reportFile);
}

const manager = new RunbookStateManager(cwd);
const actorService = createCliRunbookActorService(manager, createCliCommandServices());
const innerRunner = createEffectfulActorMutationRunner(cwd);

/** Test adapter that parks exactly before the real runner's authority capture. */
class CaptureBarrierRunner implements EffectfulActorMutationRunner {
  private parked = false;

  async run<TResult>(
    input: PreflightEffectfulActorMutationRunnerInput<TResult>,
  ): Promise<GuardedMutationResult<ActorSyncResult> | PreEffectActorMutationReturn<TResult>>;
  async run(
    input: EffectfulActorMutationRunnerInput,
  ): Promise<GuardedMutationResult<ActorSyncResult>>;
  async run<TResult>(
    input: EffectfulActorMutationRunnerInput | PreflightEffectfulActorMutationRunnerInput<TResult>,
  ): Promise<GuardedMutationResult<ActorSyncResult> | PreEffectActorMutationReturn<TResult>> {
    if (!this.parked) {
      this.parked = true;
      // This is the real command-capture seam: progression selected runnable
      // command input, but the runner has not yet captured authority, acquired
      // a lease, or crossed an effect boundary. The parent now runs a separate
      // actual CLI PASS process to terminal and releases this worker afterwards.
      writeFileSync(readyFile, String(process.pid));
      await awaitBarrier();
    }
    if ('beforeEffect' in input) return innerRunner.run(input);
    return innerRunner.run(input);
  }

  runAll<TResult>(
    input: EffectfulActorMutationSetRunnerInput<TResult>,
  ): Promise<EffectfulActorMutationSetRunnerResult<TResult>> {
    return innerRunner.runAll(input);
  }
}

const barrierRunner = new CaptureBarrierRunner();

try {
  const state = await manager.load(runId);
  if (!state) throw new Error(`progression-driver-child: run ${runId} is missing`);
  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  const events: string[] = [];
  emitter.subscribe((event) => events.push(event.type));
  const claimId = assertClaimId(claimIdValue);
  // Obtain activation through the same public core lifecycle ingress as a CLI
  // command. FAIL is authored as GOTO 1 in this witness: it leaves the run on
  // the command step and returns core's opaque, verified activation directive.
  const { seam } = buildNonDelegatingLifecycleSeam(cwd);
  const ingress = await seam.runTransition({
    command: 'fail',
    callerEvidence: readLifecycleCallerEvidence({ claimId }),
    targetSelector: { kind: 'claim', claimId },
    terminalPolicy: { releaseOnTerminal: true },
  });
  if (ingress.kind !== 'applied' || ingress.progression.kind !== 'activate') {
    throw new Error(
      `progression-driver-child: FAIL ingress did not activate: ${JSON.stringify(ingress)}`,
    );
  }
  // Match the CLI's observation gate: every initiating transition observation
  // is delivered synchronously before progression may begin another turn.
  for (const event of ingress.events) emitter.emit(event);
  const outcome = await activateRunProgression(
    ingress.progression.authority,
    {
      manager,
      actorService,
      sessionService: new SessionService(manager),
      actorMutationRunner: barrierRunner,
      loadSteps: (loaded) => getRunbookFromState(loaded, cwd),
      sink: emitter,
      dispatchInlineChild: async () => ({ kind: 'waiting' }),
      propagateTerminal: async () => ({ kind: 'propagated' }),
    },
    ingress.progression.entryBoundary,
  );
  publish({ ok: true, pid: process.pid, outcome, events });
} catch (error: unknown) {
  publish({
    ok: false,
    pid: process.pid,
    error: getErrorMessage(error),
  });
  process.exitCode = 1;
}
