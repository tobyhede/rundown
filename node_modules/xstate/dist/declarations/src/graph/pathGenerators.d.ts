import { EventObject, Snapshot } from "../index.js";
import { PathGenerator } from "./types.js";
export declare const createShortestPathsGen: <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput>() => PathGenerator<TSnapshot, TEvent, TInput>;
export declare const createSimplePathsGen: <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput>() => PathGenerator<TSnapshot, TEvent, TInput>;
