'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var actors_dist_xstateActors = require('../actors/dist/xstate-actors.cjs.js');
var guards_dist_xstateGuards = require('./raise-ad4f12ad.cjs.js');
var StateMachine = require('./StateMachine-f73271f9.cjs.js');
var assign = require('./assign-ae103a72.cjs.js');
var log = require('./log-ec818628.cjs.js');
require('../dev/dist/xstate-dev.cjs.js');

/**
 * Asserts that the given event object is of the specified type or types. Throws
 * an error if the event object is not of the specified types.
 *
 * @example
 *
 * ```ts
 * // ...
 * entry: ({ event }) => {
 *   assertEvent(event, 'doNothing');
 *   // event is { type: 'doNothing' }
 * },
 * // ...
 * exit: ({ event }) => {
 *   assertEvent(event, 'greet');
 *   // event is { type: 'greet'; message: string }
 *
 *   assertEvent(event, ['greet', 'notify']);
 *   // event is { type: 'greet'; message: string }
 *   // or { type: 'notify'; message: string; level: 'info' | 'error' }
 * },
 * ```
 */
function assertEvent(event, type) {
  const types = guards_dist_xstateGuards.toArray(type);
  const matches = types.some(descriptor => guards_dist_xstateGuards.matchesEventDescriptor(event.type, descriptor));
  if (!matches) {
    const typesText = types.length === 1 ? `type matching "${types[0]}"` : `one of types matching "${types.join('", "')}"`;
    throw new Error(`Expected event ${JSON.stringify(event)} to have ${typesText}`);
  }
}

/**
 * Creates a state machine (statechart) with the given configuration.
 *
 * The state machine represents the pure logic of a state machine actor.
 *
 * @example
 *
 * ```ts
 * import { createMachine } from 'xstate';
 *
 * const lightMachine = createMachine({
 *   id: 'light',
 *   initial: 'green',
 *   states: {
 *     green: {
 *       on: {
 *         TIMER: { target: 'yellow' }
 *       }
 *     },
 *     yellow: {
 *       on: {
 *         TIMER: { target: 'red' }
 *       }
 *     },
 *     red: {
 *       on: {
 *         TIMER: { target: 'green' }
 *       }
 *     }
 *   }
 * });
 *
 * const lightActor = createActor(lightMachine);
 * lightActor.start();
 *
 * lightActor.send({ type: 'TIMER' });
 * ```
 *
 * @param config The state machine configuration.
 * @param options DEPRECATED: use `setup({ ... })` or `machine.provide({ ... })`
 *   to provide machine implementations instead.
 */
function createMachine(config, implementations) {
  return new StateMachine.StateMachine(config, implementations);
}

/** @internal */
function createInertActorScope(actorLogic) {
  const self = guards_dist_xstateGuards.createActor(actorLogic);
  const inertActorScope = {
    self,
    defer: () => {},
    id: '',
    logger: () => {},
    sessionId: '',
    stopChild: () => {},
    system: self.system,
    emit: () => {},
    actionExecutor: () => {}
  };
  return inertActorScope;
}

/** @deprecated Use `initialTransition(…)` instead. */
function getInitialSnapshot(actorLogic, ...[input]) {
  const actorScope = createInertActorScope(actorLogic);
  return actorLogic.getInitialSnapshot(actorScope, input);
}

/**
 * Determines the next snapshot for the given `actorLogic` based on the given
 * `snapshot` and `event`.
 *
 * If the `snapshot` is `undefined`, the initial snapshot of the `actorLogic` is
 * used.
 *
 * @deprecated Use `transition(…)` instead.
 * @example
 *
 * ```ts
 * import { getNextSnapshot } from 'xstate';
 * import { trafficLightMachine } from './trafficLightMachine.ts';
 *
 * const nextSnapshot = getNextSnapshot(
 *   trafficLightMachine, // actor logic
 *   undefined, // snapshot (or initial state if undefined)
 *   { type: 'TIMER' }
 * ); // event object
 *
 * console.log(nextSnapshot.value);
 * // => 'yellow'
 *
 * const nextSnapshot2 = getNextSnapshot(
 *   trafficLightMachine, // actor logic
 *   nextSnapshot, // snapshot
 *   { type: 'TIMER' }
 * ); // event object
 *
 * console.log(nextSnapshot2.value);
 * // =>'red'
 * ```
 */
function getNextSnapshot(actorLogic, snapshot, event) {
  const inertActorScope = createInertActorScope(actorLogic);
  inertActorScope.self._snapshot = snapshot;
  return actorLogic.transition(snapshot, event, inertActorScope);
}

// at the moment we allow extra actors - ones that are not specified by `children`
// this could be reconsidered in the future

// used to keep only StateSchema relevant keys
// this helps with type serialization as it makes the inferred type much shorter when dealing with huge configs

function setup({
  schemas,
  actors,
  actions,
  guards,
  delays
}) {
  return {
    assign: assign.assign,
    sendTo: log.sendTo,
    raise: guards_dist_xstateGuards.raise,
    log: log.log,
    cancel: guards_dist_xstateGuards.cancel,
    stopChild: guards_dist_xstateGuards.stopChild,
    enqueueActions: log.enqueueActions,
    emit: log.emit,
    spawnChild: guards_dist_xstateGuards.spawnChild,
    createStateConfig: config => config,
    createAction: fn => fn,
    createMachine: config => createMachine({
      ...config,
      schemas
    }, {
      actors,
      actions,
      guards,
      delays
    }),
    extend: extended => setup({
      schemas,
      actors,
      actions: {
        ...actions,
        ...extended.actions
      },
      guards: {
        ...guards,
        ...extended.guards
      },
      delays: {
        ...delays,
        ...extended.delays
      }
    })
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class SimulatedClock {
  constructor() {
    this.timeouts = new Map();
    this._now = 0;
    this._id = 0;
    this._flushing = false;
    this._flushingInvalidated = false;
  }
  now() {
    return this._now;
  }
  getId() {
    return this._id++;
  }
  setTimeout(fn, timeout) {
    this._flushingInvalidated = this._flushing;
    const id = this.getId();
    this.timeouts.set(id, {
      start: this.now(),
      timeout,
      fn
    });
    return id;
  }
  clearTimeout(id) {
    this._flushingInvalidated = this._flushing;
    this.timeouts.delete(id);
  }
  set(time) {
    if (this._now > time) {
      throw new Error('Unable to travel back in time');
    }
    this._now = time;
    this.flushTimeouts();
  }
  flushTimeouts() {
    if (this._flushing) {
      this._flushingInvalidated = true;
      return;
    }
    this._flushing = true;
    const sorted = [...this.timeouts].sort(([_idA, timeoutA], [_idB, timeoutB]) => {
      const endA = timeoutA.start + timeoutA.timeout;
      const endB = timeoutB.start + timeoutB.timeout;
      return endB > endA ? -1 : 1;
    });
    for (const [id, timeout] of sorted) {
      if (this._flushingInvalidated) {
        this._flushingInvalidated = false;
        this._flushing = false;
        this.flushTimeouts();
        return;
      }
      if (this.now() - timeout.start >= timeout.timeout) {
        this.timeouts.delete(id);
        timeout.fn.call(null);
      }
    }
    this._flushing = false;
  }
  increment(ms) {
    this._now += ms;
    this.flushTimeouts();
  }
}

/**
 * Returns a promise that resolves to the `output` of the actor when it is done.
 *
 * @example
 *
 * ```ts
 * const machine = createMachine({
 *   // ...
 *   output: {
 *     count: 42
 *   }
 * });
 *
 * const actor = createActor(machine);
 *
 * actor.start();
 *
 * const output = await toPromise(actor);
 *
 * console.log(output);
 * // logs { count: 42 }
 * ```
 */
function toPromise(actor) {
  return new Promise((resolve, reject) => {
    actor.subscribe({
      complete: () => {
        resolve(actor.getSnapshot().output);
      },
      error: reject
    });
  });
}

/**
 * Given actor `logic`, a `snapshot`, and an `event`, returns a tuple of the
 * `nextSnapshot` and `actions` to execute.
 *
 * This is a pure function that does not execute `actions`.
 */
function transition(logic, snapshot, event) {
  const executableActions = [];
  const actorScope = createInertActorScope(logic);
  actorScope.actionExecutor = action => {
    executableActions.push(action);
  };
  const nextSnapshot = logic.transition(snapshot, event, actorScope);
  return [nextSnapshot, executableActions];
}

/**
 * Given actor `logic` and optional `input`, returns a tuple of the
 * `nextSnapshot` and `actions` to execute from the initial transition (no
 * previous state).
 *
 * This is a pure function that does not execute `actions`.
 */
function initialTransition(logic, ...[input]) {
  const executableActions = [];
  const actorScope = createInertActorScope(logic);
  actorScope.actionExecutor = action => {
    executableActions.push(action);
  };
  const nextSnapshot = logic.getInitialSnapshot(actorScope, input);
  return [nextSnapshot, executableActions];
}

const defaultWaitForOptions = {
  timeout: Infinity // much more than 10 seconds
};

/**
 * Subscribes to an actor ref and waits for its emitted value to satisfy a
 * predicate, and then resolves with that value. Will throw if the desired state
 * is not reached after an optional timeout. (defaults to Infinity).
 *
 * @example
 *
 * ```js
 * const state = await waitFor(someService, (state) => {
 *   return state.hasTag('loaded');
 * });
 *
 * state.hasTag('loaded'); // true
 * ```
 *
 * @param actorRef The actor ref to subscribe to
 * @param predicate Determines if a value matches the condition to wait for
 * @param options
 * @returns A promise that eventually resolves to the emitted value that matches
 *   the condition
 */
function waitFor(actorRef, predicate, options) {
  const resolvedOptions = {
    ...defaultWaitForOptions,
    ...options
  };
  return new Promise((res, rej) => {
    const {
      signal
    } = resolvedOptions;
    if (signal?.aborted) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      rej(signal.reason);
      return;
    }
    let done = false;
    const handle = resolvedOptions.timeout === Infinity ? undefined : setTimeout(() => {
      dispose();
      rej(new Error(`Timeout of ${resolvedOptions.timeout} ms exceeded`));
    }, resolvedOptions.timeout);
    const dispose = () => {
      clearTimeout(handle);
      done = true;
      sub?.unsubscribe();
      if (abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };
    function checkEmitted(emitted) {
      if (predicate(emitted)) {
        dispose();
        res(emitted);
      }
    }

    /**
     * If the `signal` option is provided, this will be the listener for its
     * `abort` event
     */
    let abortListener;
    // eslint-disable-next-line prefer-const
    let sub; // avoid TDZ when disposing synchronously

    // See if the current snapshot already matches the predicate
    checkEmitted(actorRef.getSnapshot());
    if (done) {
      return;
    }

    // only define the `abortListener` if the `signal` option is provided
    if (signal) {
      abortListener = () => {
        dispose();
        // XState does not "own" the signal, so we should reject with its reason (if any)
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        rej(signal.reason);
      };
      signal.addEventListener('abort', abortListener);
    }
    sub = actorRef.subscribe({
      next: checkEmitted,
      error: err => {
        dispose();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        rej(err);
      },
      complete: () => {
        dispose();
        rej(new Error(`Actor terminated without satisfying predicate`));
      }
    });
    if (done) {
      sub.unsubscribe();
    }
  });
}

exports.createEmptyActor = actors_dist_xstateActors.createEmptyActor;
exports.fromCallback = actors_dist_xstateActors.fromCallback;
exports.fromEventObservable = actors_dist_xstateActors.fromEventObservable;
exports.fromObservable = actors_dist_xstateActors.fromObservable;
exports.fromPromise = actors_dist_xstateActors.fromPromise;
exports.fromTransition = actors_dist_xstateActors.fromTransition;
exports.Actor = guards_dist_xstateGuards.Actor;
exports.__unsafe_getAllOwnEventDescriptors = guards_dist_xstateGuards.getAllOwnEventDescriptors;
exports.and = guards_dist_xstateGuards.and;
exports.cancel = guards_dist_xstateGuards.cancel;
exports.createActor = guards_dist_xstateGuards.createActor;
exports.getStateNodes = guards_dist_xstateGuards.getStateNodes;
exports.interpret = guards_dist_xstateGuards.interpret;
exports.isMachineSnapshot = guards_dist_xstateGuards.isMachineSnapshot;
exports.matchesState = guards_dist_xstateGuards.matchesState;
exports.not = guards_dist_xstateGuards.not;
exports.or = guards_dist_xstateGuards.or;
exports.pathToStateValue = guards_dist_xstateGuards.pathToStateValue;
exports.raise = guards_dist_xstateGuards.raise;
exports.spawnChild = guards_dist_xstateGuards.spawnChild;
exports.stateIn = guards_dist_xstateGuards.stateIn;
exports.stop = guards_dist_xstateGuards.stop;
exports.stopChild = guards_dist_xstateGuards.stopChild;
exports.toObserver = guards_dist_xstateGuards.toObserver;
exports.StateMachine = StateMachine.StateMachine;
exports.StateNode = StateMachine.StateNode;
exports.assign = assign.assign;
exports.SpecialTargets = log.SpecialTargets;
exports.emit = log.emit;
exports.enqueueActions = log.enqueueActions;
exports.forwardTo = log.forwardTo;
exports.log = log.log;
exports.sendParent = log.sendParent;
exports.sendTo = log.sendTo;
exports.SimulatedClock = SimulatedClock;
exports.assertEvent = assertEvent;
exports.createMachine = createMachine;
exports.getInitialSnapshot = getInitialSnapshot;
exports.getNextSnapshot = getNextSnapshot;
exports.initialTransition = initialTransition;
exports.setup = setup;
exports.toPromise = toPromise;
exports.transition = transition;
exports.waitFor = waitFor;
