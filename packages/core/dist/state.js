// src/state.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { createActor } from 'xstate';
import { createStepNumber } from './types.js';
import { WorkflowStateSchema } from './schemas.js';
import { compileWorkflowToMachine } from './compiler.js';
const STATE_DIR = '.claude/rundown/workflows';
const SESSION_FILE = '.claude/rundown/session.json';
function generateId() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const random = Math.random().toString(36).slice(2, 8);
    return `wf-${date}-${random}`;
}
export class WorkflowStateManager {
    cwd;
    constructor(cwd) {
        this.cwd = cwd;
    }
    get stateDir() {
        return path.join(this.cwd, STATE_DIR);
    }
    get sessionPath() {
        return path.join(this.cwd, SESSION_FILE);
    }
    statePath(id) {
        return path.join(this.stateDir, `${id}.json`);
    }
    async create(workflowFile, workflow, options) {
        const id = generateId();
        const now = new Date().toISOString();
        const initialStep = workflow.steps[0];
        const stepNum = initialStep.number ?? 1;
        const state = {
            id,
            workflow: workflowFile,
            title: workflow.title,
            description: workflow.description,
            step: stepNum,
            stepName: initialStep.description,
            retryCount: 0,
            variables: {},
            steps: [],
            pendingSteps: [],
            agentBindings: {},
            agentId: options?.agentId,
            parentWorkflowId: options?.parentWorkflowId,
            parentStepId: options?.parentStepId,
            startedAt: now,
            updatedAt: now,
            prompted: options?.prompted
        };
        await this.save(state);
        return state;
    }
    async load(id) {
        try {
            const content = await fs.readFile(this.statePath(id), 'utf8');
            const parsed = JSON.parse(content);
            const result = WorkflowStateSchema.safeParse(parsed);
            if (!result.success)
                return null;
            return result.data;
        }
        catch {
            return null;
        }
    }
    /**
     * Initialize an XState actor for a workflow
     */
    async createActor(id, steps) {
        const state = await this.load(id);
        if (!state)
            return null;
        const machine = compileWorkflowToMachine(steps);
        const actor = createActor(machine, {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
            snapshot: state.snapshot
        });
        actor.start();
        return actor;
    }
    async save(state) {
        await fs.mkdir(this.stateDir, { recursive: true });
        const updated = {
            ...state,
            updatedAt: new Date().toISOString()
        };
        await fs.writeFile(this.statePath(state.id), JSON.stringify(updated, null, 2));
    }
    async update(id, updates) {
        const existing = await this.load(id);
        if (!existing) {
            throw new Error(`Workflow ${id} not found`);
        }
        const updated = {
            ...existing,
            ...updates,
            variables: { ...existing.variables, ...(updates.variables ?? {}) },
            updatedAt: new Date().toISOString()
        };
        await this.save(updated);
        return updated;
    }
    async setLastResult(id, result) {
        await this.update(id, { lastResult: result });
    }
    async isParentPrompted(parentWorkflowId) {
        const parent = await this.load(parentWorkflowId);
        return parent?.prompted ?? false;
    }
    /**
     * Update workflow state from an XState actor snapshot
     */
    async updateFromActor(id, actor, steps) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        const snapshot = actor.getPersistedSnapshot();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const stateValue = snapshot.value;
        // If the workflow is in a final state, don't try to parse a step number.
        // Just update the snapshot and variables, preserving the last step number.
        if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const variables = snapshot.context.variables;
            return await this.update(id, { variables, snapshot });
        }
        const match = /^step_(\d+)(?:_(\S+))?$/.exec(stateValue);
        const stepNum = match ? parseInt(match[1], 10) : 1;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        let substep = snapshot.context.substep;
        if (!substep && match?.[2]) {
            substep = match[2];
        }
        const step = steps.find(s => s.number === stepNum) ?? steps[0];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const retryCount = snapshot.context.retryCount;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const variables = snapshot.context.variables;
        return await this.update(id, {
            step: createStepNumber(stepNum) ?? steps[0].number,
            substep,
            stepName: step.description,
            retryCount,
            variables,
            snapshot
        });
    }
    async delete(id) {
        try {
            await fs.unlink(this.statePath(id));
        }
        catch {
            /* intentionally ignored */
        }
    }
    async getActive(agentId) {
        const session = await this.loadSession();
        // Migration: handle old format
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (session.activeWorkflow && !session.stacks && !session.defaultStack) {
            return await this.load(session.activeWorkflow);
        }
        let stack;
        if (agentId) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            stack = session.stacks?.[agentId] ?? [];
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            stack = session.defaultStack ?? [];
        }
        const topId = stack[stack.length - 1];
        return topId ? await this.load(topId) : null;
    }
    /**
     * @deprecated Use pushWorkflow() and popWorkflow() instead.
     * This method only sets activeWorkflow for backwards compatibility.
     * New code should use the stack-based methods for proper per-agent isolation.
     */
    async setActive(id) {
        await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
        let session = { activeWorkflow: null, stacks: {}, defaultStack: [] };
        try {
            const content = await fs.readFile(this.sessionPath, 'utf8');
            session = JSON.parse(content);
        }
        catch {
            /* use default */
        }
        session.activeWorkflow = id;
        await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
    }
    async pushWorkflow(id, agentId) {
        const session = await this.loadSession();
        // Initialize stacks if not present (migration)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session.stacks) {
            session.stacks = {};
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session.defaultStack) {
            session.defaultStack = [];
        }
        if (agentId) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!session.stacks[agentId]) {
                session.stacks[agentId] = [];
            }
            session.stacks[agentId].push(id);
        }
        else {
            session.defaultStack.push(id);
        }
        await this.saveSession(session);
    }
    async popWorkflow(agentId) {
        const session = await this.loadSession();
        // Initialize if not present
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session.stacks) {
            session.stacks = {};
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session.defaultStack) {
            session.defaultStack = [];
        }
        let stack;
        if (agentId) {
            stack = session.stacks[agentId] ?? [];
            stack.pop();
            session.stacks[agentId] = stack;
        }
        else {
            stack = session.defaultStack;
            stack.pop();
            session.defaultStack = stack;
        }
        await this.saveSession(session);
        // Return new top (parent workflow)
        return stack[stack.length - 1] ?? null;
    }
    async list() {
        try {
            const files = await fs.readdir(this.stateDir);
            const states = [];
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const id = file.replace('.json', '');
                    const state = await this.load(id);
                    if (state)
                        states.push(state);
                }
            }
            return states;
        }
        catch {
            return [];
        }
    }
    async pushPendingStep(id, pending) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        await this.update(id, {
            pendingSteps: [...state.pendingSteps, pending]
        });
    }
    async popPendingStep(id) {
        const state = await this.load(id);
        if (!state || state.pendingSteps.length === 0)
            return null;
        const [first, ...rest] = state.pendingSteps;
        await this.update(id, { pendingSteps: rest });
        return first;
    }
    async bindAgent(id, agentId, stepId) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        const binding = {
            stepId,
            status: 'running'
        };
        await this.update(id, {
            agentBindings: {
                ...state.agentBindings,
                [agentId]: binding
            }
        });
    }
    async getAgentBinding(id, agentId) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        return state.agentBindings[agentId] ?? null;
    }
    async updateAgentBinding(id, agentId, updates) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        const existing = state.agentBindings[agentId];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!existing)
            throw new Error(`No binding for agent ${agentId}`);
        await this.update(id, {
            agentBindings: {
                ...state.agentBindings,
                [agentId]: { ...existing, ...updates }
            }
        });
    }
    async stash(agentId) {
        const session = await this.loadSession();
        // Get the active workflow ID - check stacks first, then fall back to activeWorkflow
        let activeId = null;
        if (agentId) {
            // Agent-specific stack
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            const stack = session.stacks?.[agentId];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            activeId = stack?.[stack.length - 1];
        }
        else {
            // Check defaultStack first (new format), then activeWorkflow (old format)
            const stack = session.defaultStack;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            activeId = stack && stack.length > 0 ? stack[stack.length - 1] : session.activeWorkflow;
        }
        if (!activeId)
            return null;
        // Pop from appropriate stack
        if (agentId) {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (session.stacks?.[agentId]) {
                session.stacks[agentId].pop();
            }
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (session.defaultStack && session.defaultStack.length > 0) {
                session.defaultStack.pop();
            }
            else if (session.activeWorkflow) {
                // Migration: clear activeWorkflow for old format
                session.activeWorkflow = null;
            }
        }
        // Store stashed ID (one per agent would need more complex structure)
        // For now, keep single stash for backwards compat
        session.stashedWorkflowId = activeId;
        await this.saveSession(session);
        return activeId;
    }
    async pop(agentId) {
        const session = await this.loadSession();
        const stashedId = session.stashedWorkflowId;
        if (!stashedId)
            return null;
        const state = await this.load(stashedId);
        if (!state) {
            session.stashedWorkflowId = undefined;
            await this.saveSession(session);
            return null;
        }
        // Push back to appropriate location
        if (agentId) {
            // Agent-specific stack
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!session.stacks)
                session.stacks = {};
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!session.stacks[agentId])
                session.stacks[agentId] = [];
            session.stacks[agentId].push(stashedId);
        }
        else {
            // Default stack (new format) or activeWorkflow (old format for compat)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (session.defaultStack !== undefined || session.stacks !== undefined) {
                // New format: use defaultStack
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (!session.defaultStack)
                    session.defaultStack = [];
                session.defaultStack.push(stashedId);
            }
            else {
                // Old format: restore to activeWorkflow
                session.activeWorkflow = stashedId;
            }
        }
        session.stashedWorkflowId = undefined;
        await this.saveSession(session);
        return state;
    }
    async getStashedWorkflowId() {
        const session = await this.loadSession();
        return session.stashedWorkflowId ?? null;
    }
    async loadSession() {
        try {
            const content = await fs.readFile(this.sessionPath, 'utf8');
            return JSON.parse(content);
        }
        catch {
            return { activeWorkflow: null, stacks: {}, defaultStack: [] };
        }
    }
    async saveSession(session) {
        await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
        await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
    }
    async getChildWorkflowResult(childId) {
        const child = await this.load(childId);
        if (!child)
            return 'pass';
        if (child.variables.stopped === true)
            return 'fail';
        if (child.variables.completed === true)
            return 'pass';
        return null;
    }
    async initializeSubsteps(id, substeps) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        const staticSubsteps = substeps.filter(s => !s.isDynamic);
        const substepStates = staticSubsteps.map(s => ({
            id: s.id,
            status: 'pending',
            agentId: undefined,
            result: undefined
        }));
        await this.update(id, { substepStates });
    }
    async addDynamicSubstep(id) {
        const state = await this.load(id);
        if (!state)
            throw new Error(`Workflow ${id} not found`);
        const existing = state.substepStates ?? [];
        const nextId = String(existing.length + 1);
        const newSubstep = {
            id: nextId,
            status: 'pending',
            agentId: undefined,
            result: undefined
        };
        await this.update(id, {
            substepStates: [...existing, newSubstep]
        });
        return nextId;
    }
    async bindSubstepAgent(workflowId, substepId, agentId) {
        const state = await this.load(workflowId);
        if (!state)
            throw new Error(`Workflow ${workflowId} not found`);
        const substepStates = state.substepStates ?? [];
        const updated = substepStates.map(s => s.id === substepId
            ? { ...s, status: 'running', agentId }
            : s);
        await this.update(workflowId, { substepStates: updated });
    }
    async completeSubstep(workflowId, substepId, result) {
        const state = await this.load(workflowId);
        if (!state)
            throw new Error(`Workflow ${workflowId} not found`);
        const substepStates = state.substepStates ?? [];
        const updated = substepStates.map(s => s.id === substepId
            ? { ...s, status: 'done', result }
            : s);
        await this.update(workflowId, { substepStates: updated });
    }
}
//# sourceMappingURL=state.js.map