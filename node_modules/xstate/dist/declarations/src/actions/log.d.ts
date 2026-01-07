import { ActionArgs, EventObject, LogExpr, MachineContext, ParameterizedObject } from "../types.js";
type ResolvableLogValue<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject> = string | LogExpr<TContext, TExpressionEvent, TParams, TEvent>;
export interface LogAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
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
export declare function log<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject>(value?: ResolvableLogValue<TContext, TExpressionEvent, TParams, TEvent>, label?: string): LogAction<TContext, TExpressionEvent, TParams, TEvent>;
export {};
