/**
 * Discovered runbook metadata
 */
export interface DiscoveredRunbook {
    name: string;
    path: string;
    source: 'project' | 'plugin';
    description?: string;
    tags?: string[];
}
/**
 * Search path with source information
 */
interface SearchPath {
    path: string;
    source: 'project' | 'plugin';
}
/**
 * Get search paths for runbooks
 * Returns project directory first (takes precedence), then plugin directory
 */
export declare function getSearchPaths(cwd: string): SearchPath[];
/**
 * Scan a directory for *.runbook.md files and extract metadata
 */
export declare function scanDirectory(dirPath: string, source: 'project' | 'plugin'): Promise<DiscoveredRunbook[]>;
/**
 * Discover all runbooks from project and plugin directories
 * Project runbooks take precedence over plugin runbooks with same name
 */
export declare function discoverRunbooks(cwd: string): Promise<DiscoveredRunbook[]>;
/**
 * Find a runbook by name
 * Project runbooks take precedence over plugin runbooks
 */
export declare function findRunbookByName(cwd: string, name: string): Promise<DiscoveredRunbook | null>;
export {};
//# sourceMappingURL=discovery.d.ts.map