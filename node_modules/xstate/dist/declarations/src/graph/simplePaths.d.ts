import { AnyActorLogic, EventFromLogic, InputFrom } from "../index.js";
import { StatePath, TraversalOptions } from "./types.js";
export declare function getSimplePaths<TLogic extends AnyActorLogic>(logic: TLogic, options?: TraversalOptions<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>, InputFrom<TLogic>>): Array<StatePath<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>>>;
