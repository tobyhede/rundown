import type { AdjacencyMap, StatePath, Step, TraversalOptions, PathGenerator, TestModelOptions, TestParam, TestPath, TestPathResult } from "./types.js";
import { EventObject, ActorLogic, Snapshot, AnyStateMachine, EventFromLogic, SnapshotFrom, InputFrom } from "../index.js";
type GetPathOptions<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput> = Partial<TraversalOptions<TSnapshot, TEvent, TInput>> & {
    /**
     * Whether to allow deduplicate paths so that paths that are contained by
     * longer paths are included.
     *
     * @default false
     */
    allowDuplicatePaths?: boolean;
};
/**
 * Creates a test model that represents an abstract model of a system under test
 * (SUT).
 *
 * The test model is used to generate test paths, which are used to verify that
 * states in the model are reachable in the SUT.
 */
export declare class TestModel<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput> {
    testLogic: ActorLogic<TSnapshot, TEvent, TInput>;
    options: TestModelOptions<TSnapshot, TEvent, TInput>;
    defaultTraversalOptions?: TraversalOptions<TSnapshot, TEvent, TInput>;
    getDefaultOptions(): TestModelOptions<TSnapshot, TEvent, TInput>;
    constructor(testLogic: ActorLogic<TSnapshot, TEvent, TInput>, options?: Partial<TestModelOptions<TSnapshot, TEvent, TInput>>);
    getPaths(pathGenerator: PathGenerator<TSnapshot, TEvent, TInput>, options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    getShortestPaths(options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    getShortestPathsFrom(paths: Array<TestPath<TSnapshot, TEvent>>, options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    getSimplePaths(options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    getSimplePathsFrom(paths: Array<TestPath<TSnapshot, TEvent>>, options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    private _toTestPath;
    getPathsFromEvents(events: TEvent[], options?: GetPathOptions<TSnapshot, TEvent, TInput>): Array<TestPath<TSnapshot, TEvent>>;
    /**
     * An array of adjacencies, which are objects that represent each `state` with
     * the `nextState` given the `event`.
     */
    getAdjacencyMap(): AdjacencyMap<TSnapshot, TEvent>;
    testPath(path: StatePath<TSnapshot, TEvent>, params: TestParam<TSnapshot, TEvent>, options?: Partial<TestModelOptions<TSnapshot, TEvent, TInput>>): Promise<TestPathResult>;
    testState(params: TestParam<TSnapshot, TEvent>, state: TSnapshot, options?: Partial<TestModelOptions<TSnapshot, TEvent, TInput>>): Promise<void>;
    private _getStateTestKeys;
    private _getEventExec;
    testTransition(params: TestParam<TSnapshot, TEvent>, step: Step<TSnapshot, TEvent>): Promise<void>;
    private _resolveOptions;
}
/**
 * Creates a test model that represents an abstract model of a system under test
 * (SUT).
 *
 * The test model is used to generate test paths, which are used to verify that
 * states in the `machine` are reachable in the SUT.
 *
 * @example
 *
 * ```js
 * const toggleModel = createModel(toggleMachine).withEvents({
 *   TOGGLE: {
 *     exec: async (page) => {
 *       await page.click('input');
 *     }
 *   }
 * });
 * ```
 *
 * @param machine The state machine used to represent the abstract model.
 * @param options Options for the created test model:
 *
 *   - `events`: an object mapping string event types (e.g., `SUBMIT`) to an event
 *       test config (e.g., `{exec: () => {...}, cases: [...]}`)
 */
export declare function createTestModel<TMachine extends AnyStateMachine>(machine: TMachine, options?: Partial<TestModelOptions<SnapshotFrom<TMachine>, EventFromLogic<TMachine>, InputFrom<TMachine>>>): TestModel<SnapshotFrom<TMachine>, EventFromLogic<TMachine>, unknown>;
export {};
