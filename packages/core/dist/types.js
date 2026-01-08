// packages/shared/src/types.ts
// Note: active_agent NOT included - Claude Code does not provide unique
// agent identifiers. Use metadata field if you need custom agent tracking.
/**
 * All keys of SessionState as a const array
 * Using satisfies ensures compile-time validation against interface
 */
export const SESSION_STATE_KEYS = [
    'session_id',
    'started_at',
    'active_command',
    'active_skill',
    'edited_files',
    'file_extensions',
    'metadata'
];
//# sourceMappingURL=types.js.map