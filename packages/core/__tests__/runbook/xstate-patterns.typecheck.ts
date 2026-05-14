/**
 * Compile-time contract tests for the XState v5 patterns documented in
 * `docs/internal/xstate-patterns.md`.
 *
 * This file is intentionally compile-only. `npm run check:types -w
 * packages/core` evaluates the `@ts-expect-error` directives below so the
 * documentation's type-safety claims stay pinned to the installed XState
 * version.
 */

import { createActor, fromPromise, sendTo, setup } from 'xstate';

const fetchUser = fromPromise(async ({ input }: { input: { userId: string } }) => ({
  name: input.userId,
}));

const worker = fromPromise(async ({ input }: { input: { count: number } }) => input.count);

const normalizeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const patternSetup = setup({
  types: {
    context: {} as { count: number; userId: string; error?: string },
    events: {} as { type: 'submit'; value: string } | { type: 'retry' } | { type: 'cancel' },
    children: {} as {
      fetcher: 'fetchUser';
      worker: 'worker';
    },
    tags: {} as 'idle' | 'busy',
  },
  actions: {
    recordValue: (_, params: { value: string }) => {
      void params.value;
    },
    recordError: (_, params: { message: string }) => {
      void params.message;
    },
    notifyStringChild: sendTo('worker', { type: 'not-a-worker-event' }),
  },
  guards: {
    hasMinimum: (_, params: { count: number; min: number }) => params.count >= params.min,
    alwaysTrue: (_) => true,
  },
  actors: {
    fetchUser,
    worker,
  },
});

const routableMachine = patternSetup.createMachine({
  id: 'patterns',
  initial: 'idle',
  context: {
    count: 1,
    userId: 'u1',
  },
  states: {
    idle: {
      id: 'idle',
      route: {},
      tags: ['idle'],
      on: {
        submit: {
          target: 'loading',
          guard: {
            type: 'hasMinimum',
            params: ({ context }) => ({ count: context.count, min: 1 }),
          },
          actions: {
            type: 'recordValue',
            params: ({ event }) => ({ value: event.value }),
          },
        },
      },
    },
    loading: {
      id: 'loading',
      route: {},
      tags: ['busy'],
      invoke: {
        id: 'fetcher',
        src: 'fetchUser',
        input: ({ context }) => ({ userId: context.userId }),
        onDone: {
          target: 'idle',
          actions: {
            type: 'recordValue',
            params: ({ event }) => ({ value: event.output.name }),
          },
        },
        onError: {
          target: 'idle',
          actions: {
            type: 'recordError',
            params: ({ event }) => ({ message: normalizeError(event.error) }),
          },
        },
      },
    },
  },
});

const actor = createActor(routableMachine);

actor.send({ type: 'submit', value: 'ok' });
actor.send({ type: 'xstate.route', to: '#idle' });

// @ts-expect-error - event union rejects unknown event objects.
actor.send({ type: 'unknown' });

// @ts-expect-error - submit requires a string value.
actor.send({ type: 'submit', value: 1 });

// @ts-expect-error - xstate.route targets must be routable state IDs.
actor.send({ type: 'xstate.route', to: '#missing' });

patternSetup.createMachine({
  initial: 'idle',
  states: {
    idle: {
      // @ts-expect-error - unknown action source names are rejected.
      entry: 'missingAction',
    },
  },
});

patternSetup.createMachine({
  initial: 'idle',
  states: {
    idle: {
      on: {
        // @ts-expect-error - unknown guard source names are rejected.
        retry: {
          guard: 'missingGuard',
        },
      },
    },
  },
});

patternSetup.createMachine({
  initial: 'idle',
  states: {
    idle: {
      // @ts-expect-error - unknown actor source names are rejected.
      invoke: {
        src: 'missingActor',
      },
    },
  },
});

patternSetup.createMachine({
  initial: 'idle',
  states: {
    idle: {
      entry: {
        type: 'recordValue',
        // @ts-expect-error - action params must match the registered action.
        params: { wrong: 'shape' },
      },
    },
  },
});

patternSetup.createMachine({
  initial: 'idle',
  states: {
    idle: {
      // @ts-expect-error - actor input must match the actor logic input.
      invoke: {
        src: 'fetchUser',
        input: () => ({ wrong: 'shape' }),
      },
    },
  },
});

// Known XState type-system boundary: provide() can omit implementations.
routableMachine.provide({
  actions: {
    recordValue: (_, params) => {
      void params.value;
    },
  },
});

// Known XState type-system boundary: string-ID sendTo does not validate the
// target actor's event union. This intentionally compiles.
patternSetup.createMachine({
  initial: 'idle',
  context: {
    count: 1,
    userId: 'u1',
  },
  states: {
    idle: {
      entry: 'notifyStringChild',
    },
  },
});
