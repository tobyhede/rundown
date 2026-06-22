// src/workflow/hooks/index.ts
export {
  handleDelegationDispatch,
  DelegationTokenRecordingError,
  type DelegationDispatchResult,
} from './delegation-dispatch.js';
export {
  detectDelegationMarker,
  detectDelegationInToolInput,
  type DelegationDetection,
} from './delegation-detector.js';
export { handleSubagentStop, type SubagentStopResult } from './subagent-stop.js';
