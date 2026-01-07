// packages/cli/src/helpers/wrapper.ts
import { isNodeError, getErrorMessage, WorkflowSyntaxError } from '@rundown/core';
export async function withErrorHandling(fn) {
    try {
        await fn();
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            console.error(`Error: File not found or access denied`);
        }
        else if (error instanceof WorkflowSyntaxError) {
            console.error(`Syntax error: ${error.message}`);
        }
        else {
            console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
    }
}
//# sourceMappingURL=wrapper.js.map