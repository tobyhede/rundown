import { useState, useEffect, useCallback } from 'react';
import {
  getWebContainer,
  setupRundown,
  mountRunbook,
  runRdCommand,
  cleanRundownState,
} from '../../lib/webcontainer';
import type { WebContainer } from '@webcontainer/api';

/**
 * A scenario that can be executed in the interactive runner.
 */
interface Scenario {
  /** Human-readable description shown in the dropdown */
  description: string;
  /** Commands as copy-pastable strings (e.g., "rd pass", "rd run file.md") */
  commands: string[];
  /** Expected final result (e.g., "COMPLETE", "STOP") */
  result: string;
}

/**
 * Props for the RunbookRunner component.
 */
interface Props {
  /** Filename of the runbook (e.g., "goto-named.runbook.md") */
  runbookPath: string;
  /** Full content of the runbook file including frontmatter */
  runbookContent: string;
  /** Map of scenario names to scenario definitions */
  scenarios: Record<string, Scenario>;
  /** Whether to render in compact mode for embedding */
  compact?: boolean;
}

/** Component lifecycle status for WebContainer initialization and command execution */
type Status = 'idle' | 'booting' | 'loading' | 'ready' | 'running' | 'error';

/**
 * Parse command string and extract rd args.
 * Uses simple space splitting - does not handle quoted arguments.
 *
 * @param cmd - Command string (e.g., "rd pass" or "rd run --prompted file.md")
 * @returns Array of arguments without the leading "rd" command
 *
 * @example
 * parseRdArgs("rd pass") // → ["pass"]
 * parseRdArgs("rd run --prompted file.md") // → ["run", "--prompted", "file.md"]
 */
function parseRdArgs(cmd: string): string[] {
  const parts = cmd.split(' ');
  // Remove leading "rd" if present
  return parts[0] === 'rd' ? parts.slice(1) : parts;
}

/**
 * Interactive runbook runner component that executes Rundown runbooks in a WebContainer.
 *
 * Boots a WebContainer on mount, loads a pre-built snapshot with @rundown/cli,
 * and executes scenario commands step-by-step with terminal-style output.
 *
 * @param props - Component props
 * @returns React component for interactive runbook execution
 */
export function RunbookRunner({
  runbookPath,
  runbookContent,
  scenarios,
  compact = false,
}: Props) {
  const [container, setContainer] = useState<WebContainer | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedScenario, setSelectedScenario] = useState<string>(
    Object.keys(scenarios)[0] || ''
  );

  // Initialize WebContainer on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setStatus('booting');
        const wc = await getWebContainer();
        if (cancelled) return;

        setStatus('loading');
        await setupRundown(wc);
        if (cancelled) return;

        await mountRunbook(wc, runbookPath, runbookContent);
        if (cancelled) return;

        setContainer(wc);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to initialize');
        setStatus('error');
      }
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [runbookPath, runbookContent]);

  const executeStep = useCallback(async () => {
    if (!container || !selectedScenario || status !== 'ready') return;

    const scenario = scenarios[selectedScenario];
    if (!scenario || currentStep >= scenario.commands.length) return;

    const command = scenario.commands[currentStep];
    const args = parseRdArgs(command);

    setStatus('running');
    setOutput((prev) => [...prev, `$ ${command}`]);

    try {
      const result = await runRdCommand(container, args);
      setOutput((prev) => [...prev, result.output || '(no output)']);
      setCurrentStep((prev) => prev + 1);
      setStatus('ready');
    } catch (err) {
      setOutput((prev) => [
        ...prev,
        `Error: ${err instanceof Error ? err.message : 'Command failed'}`,
      ]);
      setStatus('error');
    }
  }, [container, selectedScenario, scenarios, currentStep, status]);

  const reset = useCallback(async () => {
    // Clean up runbook state in container to avoid stale state
    if (container) {
      try {
        await cleanRundownState(container);
      } catch {
        // Ignore cleanup errors
      }
    }

    setOutput([]);
    setCurrentStep(0);
    if (status === 'error') {
      setStatus('ready');
      setError(null);
    }
  }, [container, status]);

  const handleScenarioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedScenario(e.target.value);
      reset();
    },
    [reset]
  );

  const scenario = scenarios[selectedScenario];
  const isComplete = scenario && currentStep >= scenario.commands.length;
  const canRun = status === 'ready' && !isComplete;

  const statusText = {
    idle: 'Initializing...',
    booting: 'Starting WebContainer...',
    loading: 'Loading environment...',
    ready: isComplete ? 'Complete!' : 'Ready',
    running: 'Running...',
    error: 'Error',
  }[status];

  return (
    <div
      className={`bg-cyber-darker rounded-lg border border-cyber-cyan/30 ${
        compact ? 'p-4' : 'p-6'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div className="flex items-center gap-3">
          <select
            value={selectedScenario}
            onChange={handleScenarioChange}
            disabled={status === 'running'}
            className="bg-cyber-dark text-cyber-cyan border border-cyber-cyan/50 rounded px-3 py-1.5 font-mono text-sm focus:outline-none focus:border-cyber-cyan"
          >
            {Object.entries(scenarios).map(([key, s]) => (
              <option key={key} value={key}>
                {s.description || key}
              </option>
            ))}
          </select>
          <span
            className={`text-xs font-mono ${
              status === 'error'
                ? 'text-red-400'
                : status === 'ready'
                  ? 'text-green-400'
                  : 'text-yellow-400'
            }`}
          >
            {statusText}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={executeStep}
            disabled={!canRun}
            className="px-4 py-1.5 bg-cyber-cyan text-cyber-dark font-bold text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-neon-cyan transition-shadow"
          >
            {isComplete ? '✓ Complete' : 'Next Step →'}
          </button>
          <button
            onClick={reset}
            disabled={status === 'running' || output.length === 0}
            className="px-3 py-1.5 border border-cyber-magenta/50 text-cyber-magenta text-sm rounded hover:bg-cyber-magenta/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-500/50 rounded text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* Terminal Output */}
      <pre
        className={`bg-black/50 rounded p-4 font-mono text-sm text-green-400 overflow-auto ${
          compact ? 'min-h-[150px] max-h-[250px]' : 'min-h-[200px] max-h-[400px]'
        }`}
      >
        {output.length === 0 ? (
          <span className="text-gray-500">
            {status === 'ready'
              ? 'Click "Next Step →" to begin...'
              : 'Loading environment...'}
          </span>
        ) : (
          output.map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith('$')
                  ? 'text-cyber-cyan'
                  : line.startsWith('Error')
                    ? 'text-red-400'
                    : ''
              }
            >
              {line}
            </div>
          ))
        )}
      </pre>

      {/* Progress */}
      <div className="mt-3 flex items-center justify-between text-xs text-gray-500 font-mono">
        <span>
          Step {currentStep}/{scenario?.commands.length || 0}
        </span>
        <span>
          Expected: <span className="text-cyber-cyan">{scenario?.result}</span>
        </span>
      </div>
    </div>
  );
}

export default RunbookRunner;
