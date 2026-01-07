import { InspectionEvent } from "./inspection.js";
import { ActorSystemInfo, AnyActorRef, Observer, EventObject, Subscription } from "./types.js";
interface ScheduledEvent {
    id: string;
    event: EventObject;
    startedAt: number;
    delay: number;
    source: AnyActorRef;
    target: AnyActorRef;
}
export interface Clock {
    setTimeout(fn: (...args: any[]) => void, timeout: number): any;
    clearTimeout(id: any): void;
}
interface Scheduler {
    schedule(source: AnyActorRef, target: AnyActorRef, event: EventObject, delay: number, id: string | undefined): void;
    cancel(source: AnyActorRef, id: string): void;
    cancelAll(actorRef: AnyActorRef): void;
}
export interface ActorSystem<T extends ActorSystemInfo> {
    get: <K extends keyof T['actors']>(key: K) => T['actors'][K] | undefined;
    getAll: () => Partial<T['actors']>;
    inspect: (observer: Observer<InspectionEvent> | ((inspectionEvent: InspectionEvent) => void)) => Subscription;
    scheduler: Scheduler;
    getSnapshot: () => {
        _scheduledEvents: Record<string, ScheduledEvent>;
    };
    start: () => void;
    _clock: Clock;
    _logger: (...args: any[]) => void;
}
export type AnyActorSystem = ActorSystem<any>;
export declare function createSystem<T extends ActorSystemInfo>(rootActor: AnyActorRef, options: {
    clock: Clock;
    logger: (...args: any[]) => void;
    snapshot?: unknown;
}): ActorSystem<T>;
export {};
