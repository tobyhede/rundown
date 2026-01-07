import { U as XSTATE_ERROR, V as createErrorActorEvent, x as evaluateGuard, a as cancel, r as raise, b as spawnChild, s as stopChild } from './raise-da2ff7ca.esm.js';
import { a as assign } from './assign-fd69c737.esm.js';

function resolveEmit(_, snapshot, args, actionParams, {
  event: eventOrExpr
}) {
  const resolvedEvent = typeof eventOrExpr === 'function' ? eventOrExpr(args, actionParams) : eventOrExpr;
  return [snapshot, {
    event: resolvedEvent
  }, undefined];
}
function executeEmit(actorScope, {
  event
}) {
  actorScope.defer(() => actorScope.emit(event));
}
/**
 * Emits an event to event handlers registered on the actor via `actor.on(event,
 * handler)`.
 *
 * @example
 *
 * ```ts
 * import { emit } from 'xstate';
 *
 * const machine = createMachine({
 *   // ...
 *   on: {
 *     something: {
 *       actions: emit({
 *         type: 'emitted',
 *         some: 'data'
 *       })
 *     }
 *   }
 *   // ...
 * });
 *
 * const actor = createActor(machine).start();
 *
 * actor.on('emitted', (event) => {
 *   console.log(event);
 * });
 *
 * actor.send({ type: 'something' });
 * // logs:
 * // {
 * //   type: 'emitted',
 * //   some: 'data'
 * // }
 * ```
 */
function emit(/** The event to emit, or an expression that returns an event to emit. */
eventOrExpr) {
  function emit(_args, _params) {
  }
  emit.type = 'xstate.emit';
  emit.event = eventOrExpr;
  emit.resolve = resolveEmit;
  emit.execute = executeEmit;
  return emit;
}

// this is needed to make JSDoc `@link` work properly

/**
 * @remarks
 * `T | unknown` reduces to `unknown` and that can be problematic when it comes
 * to contextual typing. It especially is a problem when the union has a
 * function member, like here:
 *
 * ```ts
 * declare function test(
 *   cbOrVal: ((arg: number) => unknown) | unknown
 * ): void;
 * test((arg) => {}); // oops, implicit any
 * ```
 *
 * This type can be used to avoid this problem. This union represents the same
 * value space as `unknown`.
 */

// https://github.com/microsoft/TypeScript/issues/23182#issuecomment-379091887

// @TODO: we can't use native `NoInfer` as we need those:
// https://github.com/microsoft/TypeScript/pull/61092
// https://github.com/microsoft/TypeScript/pull/61077
// but even with those fixes native NoInfer still doesn't work - further issues have to be reproduced and fixed

/** @deprecated Use the built-in `NoInfer` type instead */

/** The full definition of an event, with a string `type`. */

/**
 * The string or object representing the state value relative to the parent
 * state node.
 *
 * @remarks
 * - For a child atomic state node, this is a string, e.g., `"pending"`.
 * - For complex state nodes, this is an object, e.g., `{ success:
 *   "someChildState" }`.
 */

/** @deprecated Use `AnyMachineSnapshot` instead */

// TODO: possibly refactor this somehow, use even a simpler type, and maybe even make `machine.options` private or something
/** @ignore */

let SpecialTargets = /*#__PURE__*/function (SpecialTargets) {
  SpecialTargets["Parent"] = "#_parent";
  SpecialTargets["Internal"] = "#_internal";
  return SpecialTargets;
}({});

/** @deprecated Use `AnyActor` instead. */

// Based on RxJS types

// TODO: in v6, this should only accept AnyActorLogic, like ActorRefFromLogic

/** @deprecated Use `Actor<T>` instead. */

/**
 * Represents logic which can be used by an actor.
 *
 * @template TSnapshot - The type of the snapshot.
 * @template TEvent - The type of the event object.
 * @template TInput - The type of the input.
 * @template TSystem - The type of the actor system.
 */

/** @deprecated */

// TODO: cover all that can be actually returned

function resolveSendTo(actorScope, snapshot, args, actionParams, {
  to,
  event: eventOrExpr,
  id,
  delay
}, extra) {
  const delaysMap = snapshot.machine.implementations.delays;
  if (typeof eventOrExpr === 'string') {
    throw new Error(
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    `Only event objects may be used with sendTo; use sendTo({ type: "${eventOrExpr}" }) instead`);
  }
  const resolvedEvent = typeof eventOrExpr === 'function' ? eventOrExpr(args, actionParams) : eventOrExpr;
  let resolvedDelay;
  if (typeof delay === 'string') {
    const configDelay = delaysMap && delaysMap[delay];
    resolvedDelay = typeof configDelay === 'function' ? configDelay(args, actionParams) : configDelay;
  } else {
    resolvedDelay = typeof delay === 'function' ? delay(args, actionParams) : delay;
  }
  const resolvedTarget = typeof to === 'function' ? to(args, actionParams) : to;
  let targetActorRef;
  if (typeof resolvedTarget === 'string') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    if (resolvedTarget === SpecialTargets.Parent) {
      targetActorRef = actorScope.self._parent;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
    else if (resolvedTarget === SpecialTargets.Internal) {
      targetActorRef = actorScope.self;
    } else if (resolvedTarget.startsWith('#_')) {
      // SCXML compatibility: https://www.w3.org/TR/scxml/#SCXMLEventProcessor
      // #_invokeid. If the target is the special term '#_invokeid', where invokeid is the invokeid of an SCXML session that the sending session has created by <invoke>, the Processor must add the event to the external queue of that session.
      targetActorRef = snapshot.children[resolvedTarget.slice(2)];
    } else {
      targetActorRef = extra.deferredActorIds?.includes(resolvedTarget) ? resolvedTarget : snapshot.children[resolvedTarget];
    }
    if (!targetActorRef) {
      throw new Error(`Unable to send event to actor '${resolvedTarget}' from machine '${snapshot.machine.id}'.`);
    }
  } else {
    targetActorRef = resolvedTarget || actorScope.self;
  }
  return [snapshot, {
    to: targetActorRef,
    targetId: typeof resolvedTarget === 'string' ? resolvedTarget : undefined,
    event: resolvedEvent,
    id,
    delay: resolvedDelay
  }, undefined];
}
function retryResolveSendTo(_, snapshot, params) {
  if (typeof params.to === 'string') {
    params.to = snapshot.children[params.to];
  }
}
function executeSendTo(actorScope, params) {
  // this forms an outgoing events queue
  // thanks to that the recipient actors are able to read the *updated* snapshot value of the sender
  actorScope.defer(() => {
    const {
      to,
      event,
      delay,
      id
    } = params;
    if (typeof delay === 'number') {
      actorScope.system.scheduler.schedule(actorScope.self, to, event, delay, id);
      return;
    }
    actorScope.system._relay(actorScope.self,
    // at this point, in a deferred task, it should already be mutated by retryResolveSendTo
    // if it initially started as a string
    to, event.type === XSTATE_ERROR ? createErrorActorEvent(actorScope.self.id, event.data) : event);
  });
}
/**
 * Sends an event to an actor.
 *
 * @param actor The `ActorRef` to send the event to.
 * @param event The event to send, or an expression that evaluates to the event
 *   to send
 * @param options Send action options
 *
 *   - `id` - The unique send event identifier (used with `cancel()`).
 *   - `delay` - The number of milliseconds to delay the sending of the event.
 */
function sendTo(to, eventOrExpr, options) {
  function sendTo(_args, _params) {
  }
  sendTo.type = 'xstate.sendTo';
  sendTo.to = to;
  sendTo.event = eventOrExpr;
  sendTo.id = options?.id;
  sendTo.delay = options?.delay;
  sendTo.resolve = resolveSendTo;
  sendTo.retryResolve = retryResolveSendTo;
  sendTo.execute = executeSendTo;
  return sendTo;
}

/**
 * Sends an event to this machine's parent.
 *
 * @param event The event to send to the parent machine.
 * @param options Options to pass into the send event.
 */
function sendParent(event, options) {
  return sendTo(SpecialTargets.Parent, event, options);
}
/**
 * Forwards (sends) an event to the `target` actor.
 *
 * @param target The target actor to forward the event to.
 * @param options Options to pass into the send action creator.
 */
function forwardTo(target, options) {
  return sendTo(target, ({
    event
  }) => event, options);
}

function resolveEnqueueActions(actorScope, snapshot, args, actionParams, {
  collect
}) {
  const actions = [];
  const enqueue = function enqueue(action) {
    actions.push(action);
  };
  enqueue.assign = (...args) => {
    actions.push(assign(...args));
  };
  enqueue.cancel = (...args) => {
    actions.push(cancel(...args));
  };
  enqueue.raise = (...args) => {
    // for some reason it fails to infer `TDelay` from `...args` here and picks its default (`never`)
    // then it fails to typecheck that because `...args` use `string` in place of `TDelay`
    actions.push(raise(...args));
  };
  enqueue.sendTo = (...args) => {
    // for some reason it fails to infer `TDelay` from `...args` here and picks its default (`never`)
    // then it fails to typecheck that because `...args` use `string` in place of `TDelay
    actions.push(sendTo(...args));
  };
  enqueue.sendParent = (...args) => {
    actions.push(sendParent(...args));
  };
  enqueue.spawnChild = (...args) => {
    actions.push(spawnChild(...args));
  };
  enqueue.stopChild = (...args) => {
    actions.push(stopChild(...args));
  };
  enqueue.emit = (...args) => {
    actions.push(emit(...args));
  };
  collect({
    context: args.context,
    event: args.event,
    enqueue,
    check: guard => evaluateGuard(guard, snapshot.context, args.event, snapshot),
    self: actorScope.self,
    system: actorScope.system
  }, actionParams);
  return [snapshot, undefined, actions];
}
/**
 * Creates an action object that will execute actions that are queued by the
 * `enqueue(action)` function.
 *
 * @example
 *
 * ```ts
 * import { createMachine, enqueueActions } from 'xstate';
 *
 * const machine = createMachine({
 *   entry: enqueueActions(({ enqueue, check }) => {
 *     enqueue.assign({ count: 0 });
 *
 *     if (check('someGuard')) {
 *       enqueue.assign({ count: 1 });
 *     }
 *
 *     enqueue('someAction');
 *   })
 * });
 * ```
 */
function enqueueActions(collect) {
  function enqueueActions(_args, _params) {
  }
  enqueueActions.type = 'xstate.enqueueActions';
  enqueueActions.collect = collect;
  enqueueActions.resolve = resolveEnqueueActions;
  return enqueueActions;
}

function resolveLog(_, snapshot, actionArgs, actionParams, {
  value,
  label
}) {
  return [snapshot, {
    value: typeof value === 'function' ? value(actionArgs, actionParams) : value,
    label
  }, undefined];
}
function executeLog({
  logger
}, {
  value,
  label
}) {
  if (label) {
    logger(label, value);
  } else {
    logger(value);
  }
}
/**
 * @param expr The expression function to evaluate which will be logged. Takes
 *   in 2 arguments:
 *
 *   - `ctx` - the current state context
 *   - `event` - the event that caused this action to be executed.
 *
 * @param label The label to give to the logged expression.
 */
function log(value = ({
  context,
  event
}) => ({
  context,
  event
}), label) {
  function log(_args, _params) {
  }
  log.type = 'xstate.log';
  log.value = value;
  log.label = label;
  log.resolve = resolveLog;
  log.execute = executeLog;
  return log;
}

export { SpecialTargets as S, emit as a, sendParent as b, enqueueActions as e, forwardTo as f, log as l, sendTo as s };
