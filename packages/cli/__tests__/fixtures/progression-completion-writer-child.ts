import { renameSync, writeFileSync } from 'node:fs';
import {
  ExecutionEventEmitter,
  RunbookCompletionService,
  RunbookStateManager,
  assertClaimId,
  deriveTransitionObservation,
  findStepOrThrow,
  getErrorMessage,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../../src/helpers/actor-service-factory.js';
import { readLifecycleCallerEvidence } from '../../src/helpers/caller-evidence.js';
import { buildNonDelegatingLifecycleSeam } from '../../src/helpers/lifecycle-seam-factory.js';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import { createCliCommandServices } from '../../src/services/execution.js';

const [mode, cwd, runId, claimIdValue, result, reportFile] = process.argv.slice(2);
if (
  (mode !== 'record' && mode !== 'apply') ||
  !cwd ||
  !runId ||
  !claimIdValue ||
  (result !== 'pass' && result !== 'fail') ||
  !reportFile
) {
  throw new Error('progression-completion-writer-child: invalid protocol arguments');
}

/** Publish a complete report atomically so the parent never reads partial JSON. */
function publish(report: unknown): void {
  const staging = `${reportFile}.partial`;
  writeFileSync(staging, JSON.stringify(report));
  renameSync(staging, reportFile);
}

try {
  if (mode === 'record') {
    const claimId = assertClaimId(claimIdValue);
    const { seam } = buildNonDelegatingLifecycleSeam(cwd);
    const recorded = await seam.runTransition({
      command: result,
      callerEvidence: readLifecycleCallerEvidence({ claimId }),
      targetSelector: { kind: 'claim', claimId },
      terminalPolicy: { releaseOnTerminal: true },
    });
    const state = await new RunbookStateManager(cwd).load(runId);
    if (!state) throw new Error(`progression-completion-writer-child: run ${runId} is missing`);
    const emitter = new ExecutionEventEmitter(state.id, state.runbook);
    const events: string[] = [];
    emitter.subscribe((event) => events.push(event.type));
    if (recorded.kind === 'applied') {
      // Match the frontend's observation gate: the recording commit's own
      // observations complete before this process reports success and allows a
      // different activation to begin its next effect.
      for (const event of recorded.events) emitter.emit(event);
    }
    publish({
      ok: true,
      pid: process.pid,
      mode,
      events,
      outcome: {
        kind: recorded.kind,
        progression: recorded.kind === 'applied' ? recorded.progression.kind : undefined,
      },
    });
  } else {
    const manager = new RunbookStateManager(cwd);
    const state = await manager.load(runId);
    if (!state) throw new Error(`progression-completion-writer-child: run ${runId} is missing`);
    const actorService = createCliRunbookActorService(manager, createCliCommandServices());
    const steps = getRunbookFromState(state, cwd);
    const emitter = new ExecutionEventEmitter(state.id, state.runbook);
    const events: string[] = [];
    emitter.subscribe((event) => events.push(event.type));
    const applied = await new RunbookCompletionService(
      manager,
      actorService,
    ).applyNextResolvedCompletion({
      runbookId: state.id,
      steps,
      terminalRelease: { role: 'addressed' },
    });
    if (applied.kind === 'applied') {
      const observation = deriveTransitionObservation({
        steps,
        currentStep: findStepOrThrow(
          steps,
          applied.entry.stateBefore.step,
          applied.entry.stateBefore.id,
        ),
        previousState: applied.entry.stateBefore,
        updatedState: applied.entry.stateAfter,
        snapshot: applied.entry.snapshot,
        result: applied.entry.completion.result,
      });
      for (const event of observation.events) emitter.emit(event);
    }
    publish({
      ok: true,
      pid: process.pid,
      mode,
      events,
      outcome: {
        kind: applied.kind,
        terminal: applied.kind === 'applied' ? applied.terminal : undefined,
      },
    });
  }
} catch (error: unknown) {
  publish({ ok: false, pid: process.pid, mode, error: getErrorMessage(error) });
  process.exitCode = 1;
}
