import { AnyActor, DevToolsAdapter } from "../types.js";
type ServiceListener = (service: AnyActor) => void;
export interface XStateDevInterface {
    register: (service: AnyActor) => void;
    unregister: (service: AnyActor) => void;
    onRegister: (listener: ServiceListener) => {
        unsubscribe: () => void;
    };
    services: Set<AnyActor>;
}
export declare function getGlobal(): typeof globalThis | undefined;
export declare function registerService(service: AnyActor): void;
export declare const devToolsAdapter: DevToolsAdapter;
export {};
