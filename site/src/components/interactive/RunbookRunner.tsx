import { useState, useEffect, useCallback, useRef } from 'react';
import * as xtermPkg from '@xterm/xterm';
// @ts-ignore
const Terminal = xtermPkg.Terminal || xtermPkg.default?.Terminal;
import * as fitPkg from '@xterm/addon-fit';
// @ts-ignore
const FitAddon = fitPkg.FitAddon || fitPkg.default?.FitAddon;
import '@xterm/xterm/css/xterm.css';
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
  /** Whether to automatically start the first command on load */
  autoStart?: boolean;
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
 * Strip ANSI escape codes from a string (helper for state parsing only).
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[JKmsu]/g, '');
}

/**
 * Interactive runbook runner component that executes Rundown runbooks in a WebContainer.
 * Uses Xterm.js for authentic terminal output rendering.
 *
 * @param props - Component props
 * @returns React component for interactive runbook execution
 */
export function RunbookRunner({
  runbookPath,
  runbookContent,
  scenarios,
  compact = false,
  autoStart = false,
}: Props) {
  const [container, setContainer] = useState<WebContainer | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedScenario, setSelectedScenario] = useState<string>(
    Object.keys(scenarios)[0] || ''
  );

  // Theme tracking
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    setIsDarkMode(html.classList.contains('dark'));

    const observer = new MutationObserver(() => {
      setIsDarkMode(html.classList.contains('dark'));
    });

    observer.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Track if we have already auto-started to prevent re-running on reset
  const hasAutoStarted = useRef(false);
  // Track previous scenario to detect user-initiated changes
  const previousScenario = useRef<string | null>(null);

  // Runbook internal state extracted from CLI output
  const [runbookStep, setRunbookStep] = useState<string>('—');
  const [runbookTotal, setRunbookTotal] = useState<string>('—');
  const [runbookResult, setRunbookResult] = useState<string | null>(null);

  // Xterm refs
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonInstance = useRef<FitAddon | null>(null);

  // Initialize Xterm on mount
  useEffect(() => {
    if (!terminalRef.current || xtermInstance.current) return;

    const term = new Terminal({
      theme: {
        background: isDarkMode ? '#00000000' : '#ffffff', // Explicit white for light mode, transparent for dark
        foreground: isDarkMode ? '#cccccc' : '#333333',
        cursor: isDarkMode ? '#00e5ff' : '#9b4dff',
        selectionBackground: isDarkMode ? 'rgba(0, 229, 255, 0.3)' : 'rgba(155, 77, 255, 0.3)',
        black: '#000000',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#d946ef',
        cyan: '#06b6d4',
        white: '#ffffff',
        brightBlack: '#6b7280',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      allowTransparency: true,
      convertEol: true, // Important for properly handling \n from Node processes
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermInstance.current = term;
    fitAddonInstance.current = fitAddon;

    // Handle resize
    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermInstance.current = null;
    };
  }, []);

  // Update Xterm theme when isDarkMode changes
  useEffect(() => {
    if (xtermInstance.current) {
      xtermInstance.current.options.theme = {
        background: isDarkMode ? '#00000000' : '#ffffff',
        foreground: isDarkMode ? '#cccccc' : '#333333',
        cursor: isDarkMode ? '#00e5ff' : '#9b4dff',
        selectionBackground: isDarkMode ? 'rgba(0, 229, 255, 0.3)' : 'rgba(155, 77, 255, 0.3)',
        black: '#000000',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#d946ef',
        cyan: '#06b6d4',
        white: '#ffffff',
        brightBlack: '#6b7280',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#e879f9',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      };
    }
  }, [isDarkMode]);

  // Reset internal runbook state when scenario changes
  const resetInternalState = useCallback(() => {
    setRunbookStep('—');
    setRunbookTotal('—');
    setRunbookResult(null);
    setCurrentStep(0);
    xtermInstance.current?.clear();
  }, []);

  // Initialize WebContainer on mount
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        setStatus('booting');
        const wc = await getWebContainer();
        if (!mounted) return;
        setContainer(wc);

        setStatus('loading');
        await setupRundown(wc);
        await mountRunbook(wc, runbookPath, runbookContent);

        if (mounted) {
          setStatus('ready');
          xtermInstance.current?.writeln('\x1b[2mEnvironment ready.\x1b[0m');
        }
      } catch (err) {
        if (mounted) {
          console.error(err);
          setStatus('error');
          setError(err instanceof Error ? err.message : String(err));
          xtermInstance.current?.writeln(`\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [runbookPath, runbookContent]);

  const executeStep = useCallback(async () => {
    if (!container || !selectedScenario || status !== 'ready') return;
    const term = xtermInstance.current;
    if (!term) return;

    const scenario = scenarios[selectedScenario];
    if (!scenario || currentStep >= scenario.commands.length) return;

    const command = scenario.commands[currentStep];
    const args = parseRdArgs(command);

    setStatus('running');
    
    // Write command prompt to terminal
    term.writeln('');
    term.writeln(`\x1b[36;1m$ ${command}\x1b[0m`);
    term.writeln('');

    try {
      // Process output chunk-by-chunk
      const processChunk = (chunk: string) => {
        // 1. Write raw chunk to Xterm (handles ANSI/colors/cursor)
        term.write(chunk);

        // 2. Parse text for Footer status updates (strip ANSI for parsing)
        const cleanChunk = stripAnsi(chunk);
        const lines = cleanChunk.split('\n');

        for (const line of lines) {
          const stepMatch = line.match(/Step:\s+([0-9.\/\{N\}]+)/);
          if (stepMatch) {
            const parts = stepMatch[1].split('/');
            setRunbookStep(parts[0]);
            setRunbookTotal(parts[1]);
          }
          const resultMatch = line.match(/Runbook:\s+([A-Z]+)/);
          if (resultMatch) {
            setRunbookResult(resultMatch[1]);
          }
        }
      };

      await runRdCommand(container, args, processChunk);
      
      setCurrentStep((prev) => prev + 1);
      setStatus('ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Command failed';
      term.writeln(`\x1b[31mError: ${msg}\x1b[0m`);
      setStatus('error');
    }
  }, [container, selectedScenario, scenarios, currentStep, status]);

  // Handle auto-start on load
  useEffect(() => {
    if (autoStart && !hasAutoStarted.current && status === 'ready' && currentStep === 0) {
      hasAutoStarted.current = true;
      executeStep();
    }
  }, [autoStart, status, currentStep, executeStep]);

  // Auto-start when scenario changes (user selection)
  useEffect(() => {
    // Skip initial mount - let autoStart handle that
    if (previousScenario.current === null) {
      previousScenario.current = selectedScenario;
      return;
    }

    // If scenario changed and we're ready at step 0, auto-execute
    if (
      selectedScenario !== previousScenario.current &&
      status === 'ready' &&
      currentStep === 0
    ) {
      previousScenario.current = selectedScenario;
      executeStep();
    }
  }, [selectedScenario, status, currentStep, executeStep]);

  const reset = useCallback(async () => {
    // Clean up runbook state in container to avoid stale state
    if (container) {
      try {
        await cleanRundownState(container);
      } catch {
        // Ignore cleanup errors
      }
    }

    resetInternalState();
    if (status === 'error') {
      setStatus('ready');
      setError(null);
    }
  }, [container, status, resetInternalState]);

  const scenario = scenarios[selectedScenario];
  const isComplete = scenario && currentStep >= scenario.commands.length;
  const canRun = status === 'ready' && !isComplete;

  const statusText = {
    idle: 'Initializing...',
    booting: 'Starting WebContainer...',
    loading: 'Loading environment...',
    ready: isComplete ? 'Complete' : 'Ready',
    running: 'Running...',
    error: 'Error',
  }[status];

  // Helper to format result color
  const getResultColor = (res: string | null) => {
    if (!res) return 'text-gray-500';
    if (res === 'COMPLETE') return 'text-green-400';
    if (res === 'STOP' || res === 'STOPPED') return 'text-red-400';
    return 'text-yellow-400';
  };

  return (
    <div
      className={`bg-gray-100 dark:bg-cyber-darker rounded-lg border border-gray-300 dark:border-cyber-cyan/30 ${ 
        compact ? 'p-4' : 'p-6 flex flex-col h-full'
      }`}
    >
      {/* Scenario Selection */}
      <div className="mb-6">
        <label className="text-[10px] uppercase tracking-wider text-cyber-purple dark:text-cyber-magenta font-bold mb-2 block opacity-80">
          Select Scenario
        </label>
        <div className="flex flex-wrap gap-2">
          {Object.entries(scenarios).map(([key]) => (
            <button
              key={key}
              disabled={status === 'running'}
              onClick={() => {
                setSelectedScenario(key);
                reset();
              }}
              className={`px-3 py-1.5 text-xs font-mono rounded border transition-all whitespace-normal text-left ${ 
                selectedScenario === key
                  ? 'bg-cyber-cyan/20 border-cyber-cyan text-gray-900 dark:text-cyber-cyan shadow-[0_0_10px_rgba(0,229,255,0.3)]'
                  : 'bg-white dark:bg-cyber-dark/50 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-500 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
              }`}
            >
              {key}
            </button>
          ))}
        </div>
        {scenario?.description && (
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-400 italic leading-relaxed">
            {scenario.description}
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4 pt-4 border-t border-gray-300 dark:border-cyber-cyan/10">
        <div className="flex items-center gap-3">
          <span
            className={`text-xs font-mono uppercase tracking-widest ${ 
              status === 'error'
                ? 'text-red-500 dark:text-red-400'
                : status === 'ready'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-yellow-600 dark:text-yellow-400'
            }`}
          >
            {statusText}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={executeStep}
            disabled={!canRun}
            className="px-4 py-1.5 bg-cyber-cyan text-gray-900 font-bold text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-neon-cyan transition-shadow"
          >
            {isComplete ? 'Complete' : 'Next Step'}
          </button>
          <button
            onClick={reset}
            // Only disable reset if nothing has happened yet
            disabled={status === 'running' || (currentStep === 0 && !error)}
            className="px-3 py-1.5 border border-cyber-purple/50 text-cyber-purple text-sm rounded hover:bg-cyber-purple/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-red-900/10 dark:bg-red-900/30 border border-red-500/50 rounded text-red-600 dark:text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {/* Terminal Output Container */}
      <div
        className={`bg-white dark:bg-black/10 rounded p-4 border border-gray-300 dark:border-white/10 overflow-hidden relative ${ 
          compact ? 'h-[250px]' : 'flex-1 min-h-[400px]'
        }`}
      >
        <div ref={terminalRef} className="h-full w-full" />
        
        {/* Placeholder/Loading State Overlay */}
        {(!container || status === 'booting' || status === 'loading') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 dark:bg-cyber-darker/80 z-10 text-gray-500 font-mono text-xs">
             <p>{statusText}</p>
          </div>
        )}
      </div>

      {/* Footer Progress & Status */}
      <div className="mt-4 flex items-center justify-between text-[10px] font-mono border-t border-gray-300 dark:border-white/5 pt-4">
        <div className="flex items-center gap-2">
          <span className="text-gray-500 uppercase tracking-tighter">Step</span>
          <span className="text-gray-900 dark:text-white font-bold">
            {runbookStep}/{runbookTotal}
          </span>
        </div>

        <div className="flex items-center gap-6">
          {runbookResult && (
            <div className="flex items-center gap-2">
              <span className="text-gray-500 uppercase tracking-tighter">Result</span>
              <span className={`font-bold ${getResultColor(runbookResult)}`}>
                {runbookResult}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-gray-500 uppercase tracking-tighter">Expected</span>
            <span className="text-cyber-purple dark:text-cyber-cyan font-bold">{scenario?.result}</span>
          </div>
        </div>
      </div>

      {/* Env Status Dot */}
      <div className="mt-4 flex justify-end">
        <div className="flex items-center gap-2 opacity-40 hover:opacity-100 transition-opacity">
          <div
            className={`w-1.5 h-1.5 rounded-full ${ 
              status === 'ready'
                ? 'bg-green-500 animate-pulse'
                : status === 'running'
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
            }`}
          />
          <span className="text-[9px] text-gray-500 uppercase tracking-widest font-bold">
            Env {status}
          </span>
        </div>
      </div>
    </div>
  );
}

export default RunbookRunner;