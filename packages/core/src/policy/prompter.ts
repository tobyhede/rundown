/**
 * Interactive permission prompter for policy decisions.
 *
 * Prompts users for permission when policy requires confirmation,
 * with options to persist grants.
 *
 * @module
 */

import { confirm, select } from '@inquirer/prompts';
import { type PolicyEvaluator } from './evaluator.js';

/**
 * Permission types that can be prompted.
 */
export type PermissionType = 'run' | 'read' | 'write' | 'env';

/**
 * Result of a permission prompt.
 */
export interface PromptResult {
  /** Whether permission was granted */
  granted: boolean;
  /** Whether to persist the grant */
  persist: boolean;
  /** Scope of persistence if applicable */
  scope?: 'session' | 'permanent';
  /** Whether the user wants to allow all (for this session) */
  allowAll?: boolean;
}

/**
 * Options for the permission prompter.
 */
export interface PrompterOptions {
  /** Skip all prompts and auto-deny (CI mode) */
  nonInteractive?: boolean;
  /** Skip all prompts and auto-allow (--yes flag) */
  autoYes?: boolean;
  /** Policy evaluator for recording grants */
  evaluator?: PolicyEvaluator;
}

/**
 * Interactive permission prompter.
 *
 * Handles permission prompts when policy requires user confirmation.
 * Supports session and permanent grants.
 *
 * @example
 * ```typescript
 * const prompter = new PolicyPrompter({ evaluator });
 *
 * const result = await prompter.requestPermission('run', 'curl https://api.example.com');
 * if (result.granted) {
 *   // Execute command
 *   if (result.persist) {
 *     // Save grant to config
 *   }
 * }
 * ```
 */
export class PolicyPrompter {
  private options: PrompterOptions;
  private sessionAllowAll = new Set<PermissionType>();
  private sessionDenyAll = new Set<PermissionType>();
  private sessionGrants = new Map<string, boolean>();

  /**
   * Create a new policy prompter.
   *
   * @param options - Prompter options
   */
  constructor(options: PrompterOptions = {}) {
    this.options = options;
  }

  /**
   * Request permission for an operation.
   *
   * @param type - Permission type (run, read, write, env)
   * @param subject - The subject of the permission (command, path, env var)
   * @param reason - Optional explanation for why permission is needed
   * @returns Prompt result with grant status
   */
  async requestPermission(
    type: PermissionType,
    subject: string,
    reason?: string
  ): Promise<PromptResult> {
    // Handle non-interactive mode
    if (this.options.nonInteractive) {
      return { granted: false, persist: false };
    }

    // Handle auto-yes mode
    if (this.options.autoYes) {
      // Record session grant if evaluator available
      if (this.options.evaluator) {
        this.options.evaluator.addSessionGrant(type, subject);
      }
      return { granted: true, persist: false };
    }

    // Check session-wide grants/denies
    if (this.sessionAllowAll.has(type)) {
      return { granted: true, persist: false, allowAll: true };
    }

    if (this.sessionDenyAll.has(type)) {
      return { granted: false, persist: false };
    }

    // Check if we already prompted for this exact subject
    const cacheKey = `${type}:${subject}`;
    const cachedGrant = this.sessionGrants.get(cacheKey);
    if (cachedGrant !== undefined) {
      return { granted: cachedGrant, persist: false };
    }

    // Get type label for display
    const typeLabel = this.getTypeLabel(type);

    try {
      // Ask for permission
      console.log(); // Add spacing
      console.log(`\x1b[33m⚠\x1b[0m  Permission required: ${typeLabel}`);
      console.log(`   ${this.formatSubject(type, subject)}`);
      if (reason) {
        console.log(`   ${reason}`);
      }
      console.log();

      const action = await select({
        message: 'Allow this operation?',
        choices: [
          { name: 'Allow once', value: 'once' },
          { name: 'Allow for this session', value: 'session' },
          { name: `Allow all ${typeLabel} for this session`, value: 'session-all' },
          { name: 'Deny once', value: 'deny-once' },
          { name: `Deny all ${typeLabel} for this session`, value: 'deny-all' },
        ],
      });

      switch (action) {
        case 'once':
          return { granted: true, persist: false };

        case 'session':
          this.sessionGrants.set(cacheKey, true);
          if (this.options.evaluator) {
            this.options.evaluator.addSessionGrant(type, subject);
          }
          return { granted: true, persist: false, scope: 'session' };

        case 'session-all':
          this.sessionAllowAll.add(type);
          return { granted: true, persist: false, allowAll: true };

        case 'deny-once':
          return { granted: false, persist: false };

        case 'deny-all':
          this.sessionDenyAll.add(type);
          return { granted: false, persist: false };

        default:
          return { granted: false, persist: false };
      }
    } catch {
      // If prompt is interrupted (ctrl+c), deny
      return { granted: false, persist: false };
    }
  }

  /**
   * Request permission with option to persist to config file.
   *
   * @param type - Permission type
   * @param subject - The subject of the permission
   * @param reason - Optional explanation
   * @returns Prompt result with grant and persistence info
   */
  async requestPersistablePermission(
    type: PermissionType,
    subject: string,
    reason?: string
  ): Promise<PromptResult> {
    // Get initial permission
    const result = await this.requestPermission(type, subject, reason);

    if (!result.granted) {
      return result;
    }

    // If granted, ask about persistence
    try {
      const shouldPersist = await confirm({
        message: 'Save this permission to your config file?',
        default: false,
      });

      if (shouldPersist) {
        const scope = await select<'session' | 'permanent'>({
          message: 'Permission scope:',
          choices: [
            { name: 'Session only (temporary)', value: 'session' },
            { name: 'Permanent (saved to config)', value: 'permanent' },
          ],
        });

        return { ...result, persist: true, scope };
      }
    } catch {
      // If interrupted, just return the initial grant
    }

    return result;
  }

  /**
   * Confirm a dangerous operation.
   *
   * @param operation - Description of the operation
   * @param details - Additional details
   * @returns True if user confirms
   */
  async confirmDangerous(operation: string, details?: string): Promise<boolean> {
    if (this.options.nonInteractive) {
      return false;
    }

    if (this.options.autoYes) {
      return true;
    }

    try {
      console.log();
      console.log(`\x1b[31m⚠\x1b[0m  Dangerous operation: ${operation}`);
      if (details) {
        console.log(`   ${details}`);
      }
      console.log();

      return await confirm({
        message: 'Are you sure you want to proceed?',
        default: false,
      });
    } catch {
      return false;
    }
  }

  /**
   * Reset session grants and denies.
   */
  reset(): void {
    this.sessionAllowAll.clear();
    this.sessionDenyAll.clear();
    this.sessionGrants.clear();
  }

  /**
   * Get human-readable label for permission type.
   */
  private getTypeLabel(type: PermissionType): string {
    switch (type) {
      case 'run':
        return 'command execution';
      case 'read':
        return 'file read';
      case 'write':
        return 'file write';
      case 'env':
        return 'environment variable access';
    }
  }

  /**
   * Format the subject for display.
   */
  private formatSubject(type: PermissionType, subject: string): string {
    switch (type) {
      case 'run':
        return `Command: \x1b[36m${subject}\x1b[0m`;
      case 'read':
        return `Path: \x1b[36m${subject}\x1b[0m (read)`;
      case 'write':
        return `Path: \x1b[36m${subject}\x1b[0m (write)`;
      case 'env':
        return `Variable: \x1b[36m${subject}\x1b[0m`;
    }
  }

}

/**
 * Create a prompter for non-interactive (CI) mode.
 *
 * @returns Prompter that auto-denies all requests
 */
export function createNonInteractivePrompter(): PolicyPrompter {
  return new PolicyPrompter({ nonInteractive: true });
}

/**
 * Create a prompter that auto-approves all requests.
 *
 * @param evaluator - Optional evaluator for recording grants
 * @returns Prompter that auto-grants all requests
 */
export function createAutoYesPrompter(evaluator?: PolicyEvaluator): PolicyPrompter {
  return new PolicyPrompter({ autoYes: true, evaluator });
}
