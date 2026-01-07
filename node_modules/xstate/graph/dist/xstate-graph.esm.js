import { createEmptyActor } from '../../actors/dist/xstate-actors.esm.js';
import { S as StateMachine } from '../../dist/StateMachine-a6d25621.esm.js';
import { f as isMachineSnapshot, h as getAllOwnEventDescriptors } from '../../dist/raise-da2ff7ca.esm.js';
import '../../dev/dist/xstate-dev.esm.js';
import '../../dist/assign-fd69c737.esm.js';

function simpleStringify(value) {
  return JSON.stringify(value);
}
function formatPathTestResult(path, testPathResult, options) {
  const resolvedOptions = {
    formatColor: (_color, string) => string,
    serializeState: simpleStringify,
    serializeEvent: simpleStringify,
    ...options
  };
  const {
    formatColor,
    serializeState,
    serializeEvent
  } = resolvedOptions;
  const {
    state
  } = path;
  const targetStateString = serializeState(state, path.steps.length ? path.steps[path.steps.length - 1].event : undefined);
  let errMessage = '';
  let hasFailed = false;
  errMessage += '\nPath:\n' + testPathResult.steps.map((s, i, steps) => {
    const stateString = serializeState(s.step.state, i > 0 ? steps[i - 1].step.event : undefined);
    const eventString = serializeEvent(s.step.event);
    const stateResult = `\tState: ${hasFailed ? formatColor('gray', stateString) : s.state.error ? (hasFailed = true, formatColor('redBright', stateString)) : formatColor('greenBright', stateString)}`;
    const eventResult = `\tEvent: ${hasFailed ? formatColor('gray', eventString) : s.event.error ? (hasFailed = true, formatColor('red', eventString)) : formatColor('green', eventString)}`;
    return [stateResult, eventResult].join('\n');
  }).concat(`\tState: ${hasFailed ? formatColor('gray', targetStateString) : testPathResult.state.error ? formatColor('red', targetStateString) : formatColor('green', targetStateString)}`).join('\n\n');
  return errMessage;
}
function getDescription(snapshot) {
  const contextString = !Object.keys(snapshot.context).length ? '' : `(${JSON.stringify(snapshot.context)})`;
  const stateStrings = snapshot._nodes.filter(sn => sn.type === 'atomic' || sn.type === 'final').map(({
    id,
    path
  }) => {
    const meta = snapshot.getMeta()[id];
    if (!meta) {
      return `"${path.join('.')}"`;
    }
    const {
      description
    } = meta;
    if (typeof description === 'function') {
      return description(snapshot);
    }
    return description ? `"${description}"` : JSON.stringify(snapshot.value);
  });
  return `state${stateStrings.length === 1 ? '' : 's'} ` + stateStrings.join(', ') + ` ${contextString}`.trim();
}

/**
 * Deduplicates your paths so that A -> B is not executed separately to A -> B
 * -> C
 */
const deduplicatePaths = (paths, serializeEvent = simpleStringify) => {
  /** Put all paths on the same level so we can dedup them */
  const allPathsWithEventSequence = [];
  paths.forEach(path => {
    allPathsWithEventSequence.push({
      path,
      eventSequence: path.steps.map(step => serializeEvent(step.event))
    });
  });

  // Sort by path length, descending
  allPathsWithEventSequence.sort((a, z) => z.path.steps.length - a.path.steps.length);
  const superpathsWithEventSequence = [];

  /** Filter out the paths that are subpaths of superpaths */
  pathLoop: for (const pathWithEventSequence of allPathsWithEventSequence) {
    // Check each existing superpath to see if the path is a subpath of it
    superpathLoop: for (const superpathWithEventSequence of superpathsWithEventSequence) {
      // eslint-disable-next-line @typescript-eslint/no-for-in-array
      for (const i in pathWithEventSequence.eventSequence) {
        // Check event sequence to determine if path is subpath, e.g.:
        //
        // This will short-circuit the check
        // ['a', 'b', 'c', 'd'] (superpath)
        // ['a', 'b', 'x']      (path)
        //
        // This will not short-circuit; path is subpath
        // ['a', 'b', 'c', 'd'] (superpath)
        // ['a', 'b', 'c']      (path)
        if (pathWithEventSequence.eventSequence[i] !== superpathWithEventSequence.eventSequence[i]) {
          // If the path is different from the superpath,
          // continue to the next superpath
          continue superpathLoop;
        }
      }

      // If we reached here, path is subpath of superpath
      // Continue & do not add path to superpaths
      continue pathLoop;
    }

    // If we reached here, path is not a subpath of any existing superpaths
    // So add it to the superpaths
    superpathsWithEventSequence.push(pathWithEventSequence);
  }
  return superpathsWithEventSequence.map(path => path.path);
};

const createShortestPathsGen = () => (logic, defaultOptions) => {
  const paths = getShortestPaths(logic, defaultOptions);
  return paths;
};
const createSimplePathsGen = () => (logic, defaultOptions) => {
  const paths = getSimplePaths(logic, defaultOptions);
  return paths;
};

const validateState = state => {
  if (state.invoke.length > 0) {
    throw new Error('Invocations on test machines are not supported');
  }
  if (state.after.length > 0) {
    throw new Error('After events on test machines are not supported');
  }
  // TODO: this doesn't account for always transitions
  [...state.entry, ...state.exit, ...[...state.transitions.values()].flatMap(t => t.flatMap(t => t.actions))].forEach(action => {
    // TODO: this doesn't check referenced actions, only the inline ones
    if (typeof action === 'function' && 'resolve' in action && typeof action.delay === 'number') {
      throw new Error('Delayed actions on test machines are not supported');
    }
  });
  for (const child of Object.values(state.states)) {
    validateState(child);
  }
};
const validateMachine = machine => {
  validateState(machine.root);
};

/**
 * Creates a test model that represents an abstract model of a system under test
 * (SUT).
 *
 * The test model is used to generate test paths, which are used to verify that
 * states in the model are reachable in the SUT.
 */
class TestModel {
  getDefaultOptions() {
    return {
      serializeState: state => simpleStringify(state),
      serializeEvent: event => simpleStringify(event),
      // For non-state-machine test models, we cannot identify
      // separate transitions, so just use event type
      serializeTransition: (state, event) => `${simpleStringify(state)}|${event?.type}`,
      events: [],
      stateMatcher: (_, stateKey) => stateKey === '*',
      logger: {
        log: console.log.bind(console),
        error: console.error.bind(console)
      }
    };
  }
  constructor(testLogic, options) {
    this.testLogic = testLogic;
    this.options = void 0;
    this.defaultTraversalOptions = void 0;
    this._toTestPath = statePath => {
      function formatEvent(event) {
        const {
          type,
          ...other
        } = event;
        const propertyString = Object.keys(other).length ? ` (${JSON.stringify(other)})` : '';
        return `${type}${propertyString}`;
      }
      const eventsString = statePath.steps.map(s => formatEvent(s.event)).join(' → ');
      return {
        ...statePath,
        test: params => this.testPath(statePath, params),
        description: isMachineSnapshot(statePath.state) ? `Reaches ${getDescription(statePath.state).trim()}: ${eventsString}` : JSON.stringify(statePath.state)
      };
    };
    this.options = {
      ...this.getDefaultOptions(),
      ...options
    };
  }
  getPaths(pathGenerator, options) {
    const allowDuplicatePaths = options?.allowDuplicatePaths ?? false;
    const paths = pathGenerator(this.testLogic, this._resolveOptions(options));
    return (allowDuplicatePaths ? paths : deduplicatePaths(paths)).map(this._toTestPath);
  }
  getShortestPaths(options) {
    return this.getPaths(createShortestPathsGen(), options);
  }
  getShortestPathsFrom(paths, options) {
    const resultPaths = [];
    for (const path of paths) {
      const shortestPaths = this.getShortestPaths({
        ...options,
        fromState: path.state
      });
      for (const shortestPath of shortestPaths) {
        resultPaths.push(this._toTestPath(joinPaths(path, shortestPath)));
      }
    }
    return resultPaths;
  }
  getSimplePaths(options) {
    return this.getPaths(createSimplePathsGen(), options);
  }
  getSimplePathsFrom(paths, options) {
    const resultPaths = [];
    for (const path of paths) {
      const shortestPaths = this.getSimplePaths({
        ...options,
        fromState: path.state
      });
      for (const shortestPath of shortestPaths) {
        resultPaths.push(this._toTestPath(joinPaths(path, shortestPath)));
      }
    }
    return resultPaths;
  }
  getPathsFromEvents(events, options) {
    const paths = getPathsFromEvents(this.testLogic, events, options);
    return paths.map(this._toTestPath);
  }

  /**
   * An array of adjacencies, which are objects that represent each `state` with
   * the `nextState` given the `event`.
   */
  getAdjacencyMap() {
    const adjMap = getAdjacencyMap(this.testLogic, this.options);
    return adjMap;
  }
  async testPath(path, params, options) {
    const testPathResult = {
      steps: [],
      state: {
        error: null
      }
    };
    try {
      for (const step of path.steps) {
        const testStepResult = {
          step,
          state: {
            error: null
          },
          event: {
            error: null
          }
        };
        testPathResult.steps.push(testStepResult);
        try {
          await this.testTransition(params, step);
        } catch (err) {
          testStepResult.event.error = err;
          throw err;
        }
        try {
          await this.testState(params, step.state, options);
        } catch (err) {
          testStepResult.state.error = err;
          throw err;
        }
      }
    } catch (err) {
      // TODO: make option
      err.message += formatPathTestResult(path, testPathResult, this.options);
      throw err;
    }
    return testPathResult;
  }
  async testState(params, state, options) {
    const resolvedOptions = this._resolveOptions(options);
    const stateTestKeys = this._getStateTestKeys(params, state, resolvedOptions);
    for (const stateTestKey of stateTestKeys) {
      await params.states?.[stateTestKey](state);
    }
  }
  _getStateTestKeys(params, state, resolvedOptions) {
    const states = params.states || {};
    const stateTestKeys = Object.keys(states).filter(stateKey => {
      return resolvedOptions.stateMatcher(state, stateKey);
    });

    // Fallthrough state tests
    if (!stateTestKeys.length && '*' in states) {
      stateTestKeys.push('*');
    }
    return stateTestKeys;
  }
  _getEventExec(params, step) {
    const eventExec = params.events?.[step.event.type];
    return eventExec;
  }
  async testTransition(params, step) {
    const eventExec = this._getEventExec(params, step);
    await eventExec?.(step);
  }
  _resolveOptions(options) {
    return {
      ...this.defaultTraversalOptions,
      ...this.options,
      ...options
    };
  }
}
function stateValuesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (typeof a === 'string' || typeof b === 'string') {
    return a === b;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every(key => stateValuesEqual(a[key], b[key]));
}
function serializeMachineTransition(snapshot, event, previousSnapshot, {
  serializeEvent
}) {
  // TODO: the stateValuesEqual check here is very likely not exactly correct
  // but I'm not sure what the correct check is and what this is trying to do
  if (!event || previousSnapshot && stateValuesEqual(previousSnapshot.value, snapshot.value)) {
    return '';
  }
  const prevStateString = previousSnapshot ? ` from ${simpleStringify(previousSnapshot.value)}` : '';
  return ` via ${serializeEvent(event)}${prevStateString}`;
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
function createTestModel(machine, options) {
  validateMachine(machine);
  const serializeEvent = options?.serializeEvent ?? simpleStringify;
  const serializeTransition = options?.serializeTransition ?? serializeMachineTransition;
  const {
    events: getEvents,
    ...otherOptions
  } = options ?? {};
  const testModel = new TestModel(machine, {
    serializeState: (state, event, prevState) => {
      // Only consider the `state` if `serializeTransition()` is opted out (empty string)
      return `${serializeSnapshot(state)}${serializeTransition(state, event, prevState, {
        serializeEvent
      })}`;
    },
    stateMatcher: (state, key) => {
      return key.startsWith('#') ? state._nodes.includes(machine.getStateNodeById(key)) : state.matches(key);
    },
    events: state => {
      const events = typeof getEvents === 'function' ? getEvents(state) : getEvents ?? [];
      return getAllOwnEventDescriptors(state).flatMap(eventType => {
        if (events.some(e => e.type === eventType)) {
          return events.filter(e => e.type === eventType);
        }
        return [{
          type: eventType
        }]; // TODO: fix types
      });
    },
    ...otherOptions
  });
  return testModel;
}

function createMockActorScope() {
  const emptyActor = createEmptyActor();
  return {
    self: emptyActor,
    logger: console.log,
    id: '',
    sessionId: Math.random().toString(32).slice(2),
    defer: () => {},
    system: emptyActor.system,
    // TODO: mock system?
    stopChild: () => {},
    emit: () => {},
    actionExecutor: () => {}
  };
}

/**
 * Returns all state nodes of the given `node`.
 *
 * @param stateNode State node to recursively get child state nodes from
 */
function getStateNodes(stateNode) {
  const {
    states
  } = stateNode;
  const nodes = Object.keys(states).reduce((accNodes, stateKey) => {
    const childStateNode = states[stateKey];
    const childStateNodes = getStateNodes(childStateNode);
    accNodes.push(childStateNode, ...childStateNodes);
    return accNodes;
  }, []);
  return nodes;
}
function getChildren(stateNode) {
  if (!stateNode.states) {
    return [];
  }
  const children = Object.keys(stateNode.states).map(key => {
    return stateNode.states[key];
  });
  return children;
}
function serializeSnapshot(snapshot) {
  const {
    value,
    context
  } = snapshot;
  return JSON.stringify({
    value,
    context: Object.keys(context ?? {}).length ? context : undefined
  });
}
function serializeEvent(event) {
  return JSON.stringify(event);
}
function createDefaultMachineOptions(machine, options) {
  const {
    events: getEvents,
    ...otherOptions
  } = options ?? {};
  const traversalOptions = {
    serializeState: serializeSnapshot,
    serializeEvent,
    events: state => {
      const events = typeof getEvents === 'function' ? getEvents(state) : getEvents ?? [];
      return getAllOwnEventDescriptors(state).flatMap(type => {
        const matchingEvents = events.filter(ev => ev.type === type);
        if (matchingEvents.length) {
          return matchingEvents;
        }
        return [{
          type
        }];
      });
    },
    fromState: machine.getInitialSnapshot(createMockActorScope(), options?.input),
    ...otherOptions
  };
  return traversalOptions;
}
function createDefaultLogicOptions() {
  return {
    serializeState: state => JSON.stringify(state),
    serializeEvent
  };
}
function toDirectedGraph(stateMachine) {
  const stateNode = stateMachine instanceof StateMachine ? stateMachine.root : stateMachine; // TODO: accept only machines

  const edges = [...stateNode.transitions.values()].flat().flatMap((t, transitionIndex) => {
    const targets = t.target ? t.target : [stateNode];
    return targets.map((target, targetIndex) => {
      const edge = {
        id: `${stateNode.id}:${transitionIndex}:${targetIndex}`,
        source: stateNode,
        target: target,
        transition: t,
        label: {
          text: t.eventType,
          toJSON: () => ({
            text: t.eventType
          })
        },
        toJSON: () => {
          const {
            label
          } = edge;
          return {
            source: stateNode.id,
            target: target.id,
            label
          };
        }
      };
      return edge;
    });
  });
  const graph = {
    id: stateNode.id,
    stateNode: stateNode,
    children: getChildren(stateNode).map(toDirectedGraph),
    edges,
    toJSON: () => {
      const {
        id,
        children,
        edges: graphEdges
      } = graph;
      return {
        id,
        children,
        edges: graphEdges
      };
    }
  };
  return graph;
}
function isMachineLogic(logic) {
  return 'getStateNodeById' in logic;
}
function resolveTraversalOptions(logic, traversalOptions, defaultOptions) {
  const resolvedDefaultOptions = defaultOptions ?? (isMachineLogic(logic) ? createDefaultMachineOptions(logic, traversalOptions) : undefined);
  const serializeState = traversalOptions?.serializeState ?? resolvedDefaultOptions?.serializeState ?? (state => JSON.stringify(state));
  const traversalConfig = {
    serializeState,
    serializeEvent,
    events: [],
    limit: Infinity,
    fromState: undefined,
    toState: undefined,
    // Traversal should not continue past the `toState` predicate
    // since the target state has already been reached at that point
    stopWhen: traversalOptions?.toState,
    ...resolvedDefaultOptions,
    ...traversalOptions
  };
  return traversalConfig;
}
function joinPaths(headPath, tailPath) {
  const secondPathSource = tailPath.steps[0].state;
  if (secondPathSource !== headPath.state) {
    throw new Error(`Paths cannot be joined`);
  }
  return {
    state: tailPath.state,
    // e.g. [A, B, C] + [C, D, E] = [A, B, C, D, E]
    steps: headPath.steps.concat(tailPath.steps.slice(1)),
    weight: headPath.weight + tailPath.weight
  };
}

function getAdjacencyMap(logic, options) {
  const {
    transition
  } = logic;
  const {
    serializeEvent,
    serializeState,
    events: getEvents,
    limit,
    fromState: customFromState,
    stopWhen
  } = resolveTraversalOptions(logic, options);
  const actorScope = createMockActorScope();
  const fromState = customFromState ?? logic.getInitialSnapshot(actorScope,
  // TODO: fix this
  options.input);
  const adj = {};
  let iterations = 0;
  const queue = [{
    nextState: fromState,
    event: undefined,
    prevState: undefined
  }];
  const stateMap = new Map();
  while (queue.length) {
    const {
      nextState: state,
      event,
      prevState
    } = queue.shift();
    if (iterations++ > limit) {
      throw new Error('Traversal limit exceeded');
    }
    const serializedState = serializeState(state, event, prevState);
    if (adj[serializedState]) {
      continue;
    }
    stateMap.set(serializedState, state);
    adj[serializedState] = {
      state,
      transitions: {}
    };
    if (stopWhen && stopWhen(state)) {
      continue;
    }
    const events = typeof getEvents === 'function' ? getEvents(state) : getEvents;
    for (const nextEvent of events) {
      const nextSnapshot = transition(state, nextEvent, actorScope);
      adj[serializedState].transitions[serializeEvent(nextEvent)] = {
        event: nextEvent,
        state: nextSnapshot
      };
      queue.push({
        nextState: nextSnapshot,
        event: nextEvent,
        prevState: state
      });
    }
  }
  return adj;
}
function adjacencyMapToArray(adjMap) {
  const adjList = [];
  for (const adjValue of Object.values(adjMap)) {
    for (const transition of Object.values(adjValue.transitions)) {
      adjList.push({
        state: adjValue.state,
        event: transition.event,
        nextState: transition.state
      });
    }
  }
  return adjList;
}

// TODO: rewrite parts of the algorithm leading to this to make this function obsolete
function alterPath(path) {
  let steps = [];
  if (!path.steps.length) {
    steps = [{
      state: path.state,
      event: {
        type: 'xstate.init'
      }
    }];
  } else {
    for (let i = 0; i < path.steps.length; i++) {
      const step = path.steps[i];
      steps.push({
        state: step.state,
        event: i === 0 ? {
          type: 'xstate.init'
        } : path.steps[i - 1].event
      });
    }
    steps.push({
      state: path.state,
      event: path.steps[path.steps.length - 1].event
    });
  }
  return {
    ...path,
    steps
  };
}

function isMachine(value) {
  return !!value && '__xstatenode' in value;
}
function getPathsFromEvents(logic, events, options) {
  const resolvedOptions = resolveTraversalOptions(logic, {
    events,
    ...options
  }, isMachine(logic) ? createDefaultMachineOptions(logic) : createDefaultLogicOptions());
  const actorScope = createMockActorScope();
  const fromState = resolvedOptions.fromState ?? logic.getInitialSnapshot(actorScope,
  // TODO: fix this
  options?.input);
  const {
    serializeState,
    serializeEvent
  } = resolvedOptions;
  const adjacency = getAdjacencyMap(logic, resolvedOptions);
  const stateMap = new Map();
  const steps = [];
  const serializedFromState = serializeState(fromState, undefined, undefined);
  stateMap.set(serializedFromState, fromState);
  let stateSerial = serializedFromState;
  let state = fromState;
  for (const event of events) {
    steps.push({
      state: stateMap.get(stateSerial),
      event
    });
    const eventSerial = serializeEvent(event);
    const {
      state: nextState,
      event: _nextEvent
    } = adjacency[stateSerial].transitions[eventSerial];
    if (!nextState) {
      throw new Error(`Invalid transition from ${stateSerial} with ${eventSerial}`);
    }
    const prevState = stateMap.get(stateSerial);
    const nextStateSerial = serializeState(nextState, event, prevState);
    stateMap.set(nextStateSerial, nextState);
    stateSerial = nextStateSerial;
    state = nextState;
  }

  // If it is expected to reach a specific state (`toState`) and that state
  // isn't reached, there are no paths
  if (resolvedOptions.toState && !resolvedOptions.toState(state)) {
    return [];
  }
  return [alterPath({
    state,
    steps,
    weight: steps.length
  })];
}

function getShortestPaths(logic, options) {
  const resolvedOptions = resolveTraversalOptions(logic, options);
  const serializeState = resolvedOptions.serializeState;
  const fromState = resolvedOptions.fromState ?? logic.getInitialSnapshot(createMockActorScope(), options?.input);
  const adjacency = getAdjacencyMap(logic, resolvedOptions);

  // weight, state, event
  const weightMap = new Map();
  const stateMap = new Map();
  const serializedFromState = serializeState(fromState, undefined, undefined);
  stateMap.set(serializedFromState, fromState);
  weightMap.set(serializedFromState, {
    weight: 0,
    state: undefined,
    event: undefined
  });
  const unvisited = new Set();
  const visited = new Set();
  unvisited.add(serializedFromState);
  for (const serializedState of unvisited) {
    const prevState = stateMap.get(serializedState);
    const {
      weight
    } = weightMap.get(serializedState);
    for (const event of Object.keys(adjacency[serializedState].transitions)) {
      const {
        state: nextState,
        event: eventObject
      } = adjacency[serializedState].transitions[event];
      const nextSerializedState = serializeState(nextState, eventObject, prevState);
      stateMap.set(nextSerializedState, nextState);
      if (!weightMap.has(nextSerializedState)) {
        weightMap.set(nextSerializedState, {
          weight: weight + 1,
          state: serializedState,
          event: eventObject
        });
      } else {
        const {
          weight: nextWeight
        } = weightMap.get(nextSerializedState);
        if (nextWeight > weight + 1) {
          weightMap.set(nextSerializedState, {
            weight: weight + 1,
            state: serializedState,
            event: eventObject
          });
        }
      }
      if (!visited.has(nextSerializedState)) {
        unvisited.add(nextSerializedState);
      }
    }
    visited.add(serializedState);
    unvisited.delete(serializedState);
  }
  const statePlanMap = {};
  const paths = [];
  weightMap.forEach(({
    weight,
    state: fromState,
    event: fromEvent
  }, stateSerial) => {
    const state = stateMap.get(stateSerial);
    const steps = !fromState ? [] : statePlanMap[fromState].paths[0].steps.concat({
      state: stateMap.get(fromState),
      event: fromEvent
    });
    paths.push({
      state,
      steps,
      weight
    });
    statePlanMap[stateSerial] = {
      state,
      paths: [{
        state,
        steps,
        weight
      }]
    };
  });
  if (resolvedOptions.toState) {
    return paths.filter(path => resolvedOptions.toState(path.state)).map(alterPath);
  }
  return paths.map(alterPath);
}

function getSimplePaths(logic, options) {
  const resolvedOptions = resolveTraversalOptions(logic, options);
  const actorScope = createMockActorScope();
  const fromState = resolvedOptions.fromState ?? logic.getInitialSnapshot(actorScope, options?.input);
  const serializeState = resolvedOptions.serializeState;
  const adjacency = getAdjacencyMap(logic, resolvedOptions);
  const stateMap = new Map();
  const visitCtx = {
    vertices: new Set(),
    edges: new Set()
  };
  const steps = [];
  const pathMap = {};
  function util(fromStateSerial, toStateSerial) {
    const fromState = stateMap.get(fromStateSerial);
    visitCtx.vertices.add(fromStateSerial);
    if (fromStateSerial === toStateSerial) {
      if (!pathMap[toStateSerial]) {
        pathMap[toStateSerial] = {
          state: stateMap.get(toStateSerial),
          paths: []
        };
      }
      const toStatePlan = pathMap[toStateSerial];
      const path2 = {
        state: fromState,
        weight: steps.length,
        steps: [...steps]
      };
      toStatePlan.paths.push(path2);
    } else {
      for (const serializedEvent of Object.keys(adjacency[fromStateSerial].transitions)) {
        const {
          state: nextState,
          event: subEvent
        } = adjacency[fromStateSerial].transitions[serializedEvent];
        if (!(serializedEvent in adjacency[fromStateSerial].transitions)) {
          continue;
        }
        const prevState = stateMap.get(fromStateSerial);
        const nextStateSerial = serializeState(nextState, subEvent, prevState);
        stateMap.set(nextStateSerial, nextState);
        if (!visitCtx.vertices.has(nextStateSerial)) {
          visitCtx.edges.add(serializedEvent);
          steps.push({
            state: stateMap.get(fromStateSerial),
            event: subEvent
          });
          util(nextStateSerial, toStateSerial);
        }
      }
    }
    steps.pop();
    visitCtx.vertices.delete(fromStateSerial);
  }
  const fromStateSerial = serializeState(fromState, undefined);
  stateMap.set(fromStateSerial, fromState);
  for (const nextStateSerial of Object.keys(adjacency)) {
    util(fromStateSerial, nextStateSerial);
  }
  const simplePaths = Object.values(pathMap).flatMap(p => p.paths);
  if (resolvedOptions.toState) {
    return simplePaths.filter(path => resolvedOptions.toState(path.state)).map(alterPath);
  }
  return simplePaths.map(alterPath);
}

export { TestModel, adjacencyMapToArray, createShortestPathsGen, createSimplePathsGen, createTestModel, getAdjacencyMap, getPathsFromEvents, getShortestPaths, getSimplePaths, getStateNodes, joinPaths, serializeSnapshot, toDirectedGraph };
