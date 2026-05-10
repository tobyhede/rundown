import { useState, useEffect, useCallback, useRef } from 'react';
import * as xtermPkg from '@xterm/xterm';
// @ts-ignore
const Terminal = xtermPkg.Terminal || xtermPkg.default?.Terminal;
import * as fitPkg from '@xterm/addon-fit';
// @ts-ignore
const FitAddon = fitPkg.FitAddon || fitPkg.default?.FitAddon;
import '@xterm/xterm/css/xterm.css';
import stripAnsi from 'strip-ansi';
import {
  getWebContainer,
  setupRundown,
  mountRunbook,
  runRdCommand,
  cleanRundownState,
} from '../../lib/webcontainer';
import type { WebContainer } from '@webcontainer/api';

interface Scenario {
  description: string;
  commands: string[];
  result: string;
}

interface Props {
  runbookPath: string;
  runbookContent: string;
  scenarios: Record<string, Scenario>;
  compact?: boolean;
  autoStart?: boolean;
}

type Status = 'idle' | 'booting' | 'loading' | 'ready' | 'running' | 'error';

type ScenarioCardCopy = { title: string; description: string };

/**
 * UI-layer card copy keyed by scenario ID in
 * `site/public/this-is-rundown.runbook.md`. The runbook's own
 * `description:` fields are flavour text and not card-friendly. If a
 * scenario isn't in this map, the runbook description (or the key, then
 * the empty string) is used as a fallback so other consumers
 * (e.g. `auto-execution` on `/explore/code-blocks`) keep rendering.
 */
const SCENARIO_CARD_COPY: Record<string, ScenarioCardCopy> = {
  rundown: { title: 'Happy path', description: 'Runs 6 steps, all pass' },
  retry: { title: 'Retry on fail', description: 'Fails, retries, eventually passes' },
  start: { title: 'Skip to end', description: 'Jumps straight to the last step' },
};

function parseRdArgs(cmd: string): string[] {
  // Dynamic import would complicate React component — use inline mini-parser
  // that handles quoted strings (sufficient for predefined scenario commands)
  const parts: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    // Skip whitespace
    while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t')) i++;
    if (i >= cmd.length) break;
    if (cmd[i] === '"' || cmd[i] === "'") {
      const quote = cmd[i];
      i++;
      let token = '';
      while (i < cmd.length && cmd[i] !== quote) { token += cmd[i]; i++; }
      if (i < cmd.length) i++; // skip closing quote
      parts.push(token);
    } else {
      let token = '';
      while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t') { token += cmd[i]; i++; }
      parts.push(token);
    }
  }
  return parts[0] === 'rd' ? parts.slice(1) : parts;
}


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
  const [mode, setMode] = useState<'text' | 'json'>('text');

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

  const hasAutoStarted = useRef(false);

  const [runbookStep, setRunbookStep] = useState<string>('—');
  const [runbookTotal] = useState<string>(() => {
    // Count only numbered H2 headings to match the codebase's `countNumberedSteps`
    // semantics (packages/core/src/runbook/step-utils.ts:26-28). Named steps like
    // `## RECOVER` are deliberately excluded — the runtime emits position.total
    // counting only numbered steps, and `formatPosition` omits the total for
    // named steps (see packages/core/src/cli/output.ts:23-30).
    const numberedCount = (runbookContent.match(/^## \d/gm) || []).length;
    return numberedCount > 0 ? String(numberedCount) : '—';
  });
  const [runbookResult, setRunbookResult] = useState<string | null>(null);

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonInstance = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current || xtermInstance.current) return;

    const term = new Terminal({
      theme: {
        background: isDarkMode ? '#0a0a0a' : '#fafafa',
        foreground: isDarkMode ? '#fafafa' : '#171717',
        cursor: isDarkMode ? '#fafafa' : '#171717',
        selectionBackground: isDarkMode ? 'rgba(250,250,250,0.2)' : 'rgba(23,23,23,0.2)',
        // All ANSI colors neutralized to foreground for monochrome output
        black: isDarkMode ? '#fafafa' : '#171717',
        red: isDarkMode ? '#fafafa' : '#171717',
        green: isDarkMode ? '#fafafa' : '#171717',
        yellow: isDarkMode ? '#fafafa' : '#171717',
        blue: isDarkMode ? '#fafafa' : '#171717',
        magenta: isDarkMode ? '#fafafa' : '#171717',
        cyan: isDarkMode ? '#fafafa' : '#171717',
        white: isDarkMode ? '#fafafa' : '#171717',
        brightBlack: isDarkMode ? '#fafafa' : '#171717',
        brightRed: isDarkMode ? '#fafafa' : '#171717',
        brightGreen: isDarkMode ? '#fafafa' : '#171717',
        brightYellow: isDarkMode ? '#fafafa' : '#171717',
        brightBlue: isDarkMode ? '#fafafa' : '#171717',
        brightMagenta: isDarkMode ? '#fafafa' : '#171717',
        brightCyan: isDarkMode ? '#fafafa' : '#171717',
        brightWhite: isDarkMode ? '#fafafa' : '#171717',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermInstance.current = term;
    fitAddonInstance.current = fitAddon;

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermInstance.current = null;
    };
  }, []);

  useEffect(() => {
    if (xtermInstance.current) {
      xtermInstance.current.options.theme = {
        background: isDarkMode ? '#0a0a0a' : '#fafafa',
        foreground: isDarkMode ? '#fafafa' : '#171717',
        cursor: isDarkMode ? '#fafafa' : '#171717',
        selectionBackground: isDarkMode ? 'rgba(250,250,250,0.2)' : 'rgba(23,23,23,0.2)',
        // All ANSI colors neutralized to foreground for monochrome output
        black: isDarkMode ? '#fafafa' : '#171717',
        red: isDarkMode ? '#fafafa' : '#171717',
        green: isDarkMode ? '#fafafa' : '#171717',
        yellow: isDarkMode ? '#fafafa' : '#171717',
        blue: isDarkMode ? '#fafafa' : '#171717',
        magenta: isDarkMode ? '#fafafa' : '#171717',
        cyan: isDarkMode ? '#fafafa' : '#171717',
        white: isDarkMode ? '#fafafa' : '#171717',
        brightBlack: isDarkMode ? '#fafafa' : '#171717',
        brightRed: isDarkMode ? '#fafafa' : '#171717',
        brightGreen: isDarkMode ? '#fafafa' : '#171717',
        brightYellow: isDarkMode ? '#fafafa' : '#171717',
        brightBlue: isDarkMode ? '#fafafa' : '#171717',
        brightMagenta: isDarkMode ? '#fafafa' : '#171717',
        brightCyan: isDarkMode ? '#fafafa' : '#171717',
        brightWhite: isDarkMode ? '#fafafa' : '#171717',
      };
    }
  }, [isDarkMode]);

  const resetInternalState = useCallback(() => {
    setRunbookStep('—');
    setRunbookResult(null);
    setCurrentStep(0);
    if (status === 'error') {
      setStatus('ready');
      setError(null);
    }
    xtermInstance.current?.clear();
  }, [status]);

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

    term.writeln('');
    term.writeln(`\x1b[36;1m$ ${command}\x1b[0m`);
    term.writeln('');

    try {
      const processChunk = (chunk: string) => {
        term.write(chunk);

        // Footer parsing is text-only — `At: <stepId>` / `Runbook: STATUS`
        // lines appear only in `--text` output. In JSON mode the footer stays
        // at placeholder values for the entire walk-through (V1 simplicity).
        if (mode === 'text') {
          const cleanChunk = stripAnsi(chunk);
          for (const line of cleanChunk.split('\n')) {
            // The `At:` line emits ONLY a step ID — never `step/total`.
            // Examples: `At:       1`, `At:       2.1`, `At:       RECOVER`.
            // Source: packages/core/src/cli/output.ts:120-122 writes
            // `data.at` directly; `data.at` is `derivePositionAt(...)` (see
            // packages/cli/src/helpers/transition-orchestrator.ts:188 and
            // goto-workflow.ts:285), which returns just the step ID.
            const stepMatch = line.match(/At:\s+([\w.]+)/);
            if (stepMatch) setRunbookStep(stepMatch[1]);
            const resultMatch = line.match(/Runbook:\s+([A-Z]+)/);
            if (resultMatch) setRunbookResult(resultMatch[1]);
          }
        }
      };

      await runRdCommand(container, args, processChunk, mode);

      setCurrentStep((prev) => prev + 1);
      setStatus('ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Command failed';
      term.writeln(`\x1b[31mError: ${msg}\x1b[0m`);
      setStatus('error');
    }
  }, [container, selectedScenario, scenarios, currentStep, status, mode]);

  useEffect(() => {
    if (autoStart && !hasAutoStarted.current && status === 'ready' && currentStep === 0) {
      hasAutoStarted.current = true;
      executeStep();
    }
  }, [autoStart, status, currentStep, executeStep]);

  const reset = useCallback(async () => {
    resetInternalState();
    if (container) {
      try {
        await cleanRundownState(container);
      } catch {
        // Ignore cleanup errors
      }
    }
  }, [container, resetInternalState]);

  const switchMode = useCallback(
    async (next: 'text' | 'json') => {
      if (next === mode) return;
      await reset();
      setMode(next);
    },
    [mode, reset]
  );

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

  return (
    <div
      className={`bg-muted rounded-lg border border-border ${compact ? 'p-4' : 'p-6 flex flex-col h-full'
        }`}
    >
      {/* Scenario Selection */}
      <div className="mb-6">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-2 block">
          Select Scenario
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Object.entries(scenarios).map(([key, sc]) => {
            const copy = SCENARIO_CARD_COPY[key];
            const title = copy?.title ?? key;
            const description = copy?.description ?? sc.description ?? '';
            const selected = selectedScenario === key;
            return (
              <button
                key={key}
                disabled={status === 'running'}
                onClick={() => {
                  if (selectedScenario === key) return;
                  setSelectedScenario(key);
                  void reset();
                }}
                aria-pressed={selected}
                className={`text-left rounded-md p-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  selected
                    ? 'border-2 border-accent bg-background'
                    : 'border border-border bg-background hover:border-foreground/50'
                }`}
              >
                <div className="text-sm font-mono font-bold text-foreground mb-1">
                  {title}
                </div>
                <div className="text-xs text-muted-foreground leading-relaxed">
                  {description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tabs + actions */}
      <div className="flex items-center justify-between gap-4 mb-4 border-b border-border">
        <div role="tablist" aria-label="Output format" className="flex">
          {(['text', 'json'] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                role="tab"
                aria-selected={active}
                onClick={() => void switchMode(m)}
                disabled={status === 'running'}
                className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  active
                    ? 'border-b-2 border-accent text-foreground'
                    : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'text' ? 'Text' : 'JSON'}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mr-2">
            {statusText}
          </span>
          <button
            onClick={executeStep}
            disabled={!canRun}
            className="h-9 px-4 text-sm btn-primary flex items-center gap-2"
          >
            {isComplete ? 'Complete' : 'Next'}
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </button>
          <button
            onClick={() => void reset()}
            disabled={status === 'running' || (currentStep === 0 && !error)}
            className="h-9 px-3 text-sm btn-secondary flex items-center gap-2"
          >
            Reset
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 bg-background border border-border rounded text-foreground text-sm font-mono">
          {error}
        </div>
      )}

      {/* Terminal Output Container */}
      <div
        className={`bg-background rounded-md p-4 border border-border overflow-hidden relative ${compact ? 'h-[250px]' : 'flex-1 min-h-[400px]'
          }`}
      >
        <div ref={terminalRef} className="h-full w-full" />

        {/* Placeholder/Loading State Overlay */}
        {(!container || status === 'booting' || status === 'loading') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 text-muted-foreground font-mono text-xs">
            <p>{statusText}</p>
          </div>
        )}
      </div>

      {/* Footer Progress & Status */}
      <div className="mt-4 flex items-center justify-between text-[10px] font-mono border-t border-border pt-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground uppercase tracking-tighter">Step</span>
            <span className="text-foreground font-bold">
              {runbookStep}/{runbookTotal}
            </span>
          </div>

          {runbookResult && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground uppercase tracking-tighter">Result</span>
                <span className="text-foreground font-bold">
                  {runbookResult}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-muted-foreground uppercase tracking-tighter">Expected</span>
                <span className="text-foreground font-bold">{scenario?.result || '—'}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default RunbookRunner;
