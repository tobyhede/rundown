import { type AnyActorRef } from 'xstate';
import { type WorkflowState, type AgentBinding, type PendingStep, type Substep, type Step, type Workflow } from './types.js';
import type { StepId } from './step-id.js';
interface CreateOptions {
    readonly agentId?: string;
    readonly parentWorkflowId?: string;
    readonly parentStepId?: StepId;
    readonly prompted?: boolean;
}
export declare class WorkflowStateManager {
    private readonly cwd;
    constructor(cwd: string);
    private get stateDir();
    private get sessionPath();
    private statePath;
    create(workflowFile: string, workflow: Workflow, options?: CreateOptions): Promise<WorkflowState>;
    load(id: string): Promise<WorkflowState | null>;
    /**
     * Initialize an XState actor for a workflow
     */
    createActor(id: string, steps: Step[]): Promise<AnyActorRef | null>;
    save(state: WorkflowState): Promise<void>;
    update(id: string, updates: Partial<Omit<WorkflowState, 'id' | 'startedAt'>>): Promise<WorkflowState>;
    setLastResult(id: string, result: 'pass' | 'fail'): Promise<void>;
    isParentPrompted(parentWorkflowId: string): Promise<boolean>;
    /**
     * Update workflow state from an XState actor snapshot
     */
    updateFromActor(id: string, actor: AnyActorRef, steps: Step[]): Promise<WorkflowState>;
    delete(id: string): Promise<void>;
    getActive(agentId?: string): Promise<WorkflowState | null>;
    /**
     * @deprecated Use pushWorkflow() and popWorkflow() instead.
     * This method only sets activeWorkflow for backwards compatibility.
     * New code should use the stack-based methods for proper per-agent isolation.
     */
    setActive(id: string | null): Promise<void>;
    pushWorkflow(id: string, agentId?: string): Promise<void>;
    popWorkflow(agentId?: string): Promise<string | null>;
    list(): Promise<WorkflowState[]>;
    pushPendingStep(id: string, pending: PendingStep): Promise<void>;
    popPendingStep(id: string): Promise<PendingStep | null>;
    bindAgent(id: string, agentId: string, stepId: StepId): Promise<void>;
    getAgentBinding(id: string, agentId: string): Promise<AgentBinding | null>;
    updateAgentBinding(id: string, agentId: string, updates: Partial<Pick<AgentBinding, 'status' | 'result' | 'childWorkflowId'>>): Promise<void>;
    stash(agentId?: string): Promise<string | null>;
    pop(agentId?: string): Promise<WorkflowState | null>;
    getStashedWorkflowId(): Promise<string | null>;
    private loadSession;
    private saveSession;
    getChildWorkflowResult(childId: string): Promise<'pass' | 'fail' | null>;
    initializeSubsteps(id: string, substeps: readonly Substep[]): Promise<void>;
    addDynamicSubstep(id: string): Promise<string>;
    bindSubstepAgent(workflowId: string, substepId: string, agentId: string): Promise<void>;
    completeSubstep(workflowId: string, substepId: string, result: 'pass' | 'fail'): Promise<void>;
}
export {};
//# sourceMappingURL=state.d.ts.map