// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useRef } from 'react';

import type { ProjectCommand } from '@shared/run-command-types';
import type {
  RunCommandLogs,
  RunCommandLogState,
} from '@/stores/task-messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  resetLogs: vi.fn(async (_params: unknown) => undefined),
  sendInput: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock('@/lib/api', () => ({
  api: {
    runCommands: {
      resetLogs: apiMocks.resetLogs,
      sendInput: apiMocks.sendInput,
    },
  },
}));

vi.mock('@/features/common/interactive-log', () => ({
  InteractiveLog: ({ log }: { log: RunCommandLogState | null }) => (
    <div data-command-log-content data-testid="log">
      {(log?.chunks ?? [])
        .flatMap((chunk) => chunk.lines)
        .map((line, index) => (
          <div key={index}>{line.line}</div>
        ))}
    </div>
  ),
}));

const { CommandLogsSection } = await import('./command-logs-section');
const { useTaskMessagesStore } = await import('@/stores/task-messages');

const TASK_ID = 'task-1';
const PROJECT_ID = 'project-1';

function makeCommand(overrides: Partial<ProjectCommand>): ProjectCommand {
  return {
    id: 'cmd',
    projectId: PROJECT_ID,
    name: 'Command',
    command: 'echo hi',
    ports: [],
    portConflictStrategy: 'prompt',
    portOverrideProvider: 'env',
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    sortOrder: 0,
    confirmBeforeRun: false,
    confirmMessage: null,
    isFavorite: false,
    isHidden: false,
    createdAt: '',
    ...overrides,
  };
}

function makeLog(lines: string[]): RunCommandLogState {
  return {
    chunks: [
      {
        id: 'chunk-1',
        lines: lines.map((line, index) => ({
          stream: 'stdout' as const,
          line,
          timestamp: index,
        })),
        lineCount: lines.length,
      },
    ],
    pendingLines: { stdout: null, stderr: null },
    trailingText: { stdout: '', stderr: '' },
    totalLineCount: lines.length,
    updatedAt: 0,
    version: 1,
  };
}

const devCommand = makeCommand({ id: 'cmd-dev', name: 'Dev Server' });
const buildCommand = makeCommand({ id: 'cmd-build', name: 'Build' });
const virtualTab = makeCommand({ id: 'virtual-expo', name: 'Expo' });

function makeRunCommands(
  startCommand: ReturnType<typeof vi.fn>,
  runningCommandIds: string[] = [],
) {
  return {
    status: {
      isRunning: runningCommandIds.length > 0,
      commands: runningCommandIds.map((id) => ({
        id,
        status: 'running' as const,
        ports: [],
      })),
    },
    statusByCommandId: {},
    isRunning: false,
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    isStartingAnyCommand: false,
    startCommand,
    startAdHocCommand: vi.fn(),
    startGroup: vi.fn(),
    stopCommand: vi.fn(),
    stopGroup: vi.fn(),
    portsInUseError: null,
    confirmKillPorts: vi.fn(),
    dismissPortsError: vi.fn(),
  } as unknown as Parameters<typeof CommandLogsSection>[0]['runCommands'];
}

function makeAvailability(commands: ProjectCommand[]) {
  return {
    commands,
    allCommands: commands,
    groups: [],
    items: [],
    state: 'ready' as const,
    hasConfiguredItems: commands.length > 0,
    retry: async () => {},
  };
}

let container: HTMLDivElement;
let root: Root;
let startCommand: ReturnType<typeof vi.fn>;
let onSelectCommand: ReturnType<typeof vi.fn>;

function Harness({
  selectedCommandId,
  virtualTabs,
  commands,
  runningCommandIds,
}: {
  selectedCommandId: string | null;
  virtualTabs?: ProjectCommand[];
  commands: ProjectCommand[];
  runningCommandIds?: string[];
}) {
  const scopeRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={scopeRef} data-testid="scope">
      <CommandLogsSection
        taskId={TASK_ID}
        projectId={PROJECT_ID}
        workingDir="/tmp/wd"
        runCommands={makeRunCommands(startCommand, runningCommandIds)}
        commandAvailability={makeAvailability(commands)}
        virtualTabs={virtualTabs}
        selectedCommandId={selectedCommandId}
        onSelectCommand={onSelectCommand}
        keyScopeRef={scopeRef}
      />
    </div>
  );
}

function render(props: Parameters<typeof Harness>[0]) {
  act(() => {
    root.render(<Harness {...props} />);
  });
}

function tabNames(): string[] {
  return [...container.querySelectorAll('button[aria-pressed]')].map(
    (button) => button.textContent?.replace(/:\d+.*/, '').trim() ?? '',
  );
}

function searchInput(): HTMLInputElement {
  const input = container.querySelector('input');
  if (!input) throw new Error('search input not found');
  return input;
}

function setSearch(value: string) {
  const input = searchInput();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressKey(
  target: Element,
  key: string,
  modifiers: { shiftKey?: boolean } = {},
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: true,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    );
  });
}

function logLines(): string[] {
  const log = container.querySelector('[data-testid="log"]');
  return [...(log?.children ?? [])].map((child) => child.textContent ?? '');
}

function seedLogs(logs: RunCommandLogs) {
  act(() => {
    useTaskMessagesStore.setState({ runCommandLogs: { [TASK_ID]: logs } });
  });
}

beforeEach(() => {
  apiMocks.resetLogs.mockClear();
  apiMocks.sendInput.mockClear();
  startCommand = vi.fn(async () => ({ started: true }));
  onSelectCommand = vi.fn();
  useTaskMessagesStore.setState({ runCommandLogs: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CommandLogsSection', () => {
  it('renders virtual tabs before configured tabs', () => {
    seedLogs({
      [devCommand.id]: makeLog(['hello world']),
      [buildCommand.id]: makeLog(['goodbye moon']),
    });
    // Running with no output yet: enough to earn a tab, and it still leads.
    render({
      selectedCommandId: null,
      virtualTabs: [virtualTab],
      commands: [devCommand, buildCommand],
      runningCommandIds: [virtualTab.id],
    });

    expect(tabNames()).toEqual(['Expo', 'Dev Server', 'Build']);
  });

  it('hides a virtual tab that is neither running nor has any output', () => {
    seedLogs({ [devCommand.id]: makeLog(['hello world']) });
    render({
      selectedCommandId: null,
      virtualTabs: [virtualTab],
      commands: [devCommand, buildCommand],
    });

    expect(tabNames()).toEqual(['Dev Server']);
  });

  it('falls back to the first tab when the selected command has no tab', () => {
    seedLogs({ [devCommand.id]: makeLog(['hello world']) });
    render({
      // A tab the visibility rule retired (cleared logs, not running), e.g. an
      // id persisted from an older session.
      selectedCommandId: virtualTab.id,
      virtualTabs: [virtualTab],
      commands: [devCommand],
    });

    expect(tabNames()).toEqual(['Dev Server']);
    expect(logLines()).toEqual(['hello world']);
  });

  it('shows the empty state instead of a log box when there are zero tabs', () => {
    render({
      selectedCommandId: virtualTab.id,
      virtualTabs: [virtualTab],
      commands: [],
    });

    expect(tabNames()).toEqual([]);
    expect(container.querySelector('[data-testid="log"]')).toBeNull();
    expect(container.textContent).toContain('No project commands configured');
  });

  it('focuses the search input on cmd+F', () => {
    seedLogs({ [devCommand.id]: makeLog(['hello world']) });
    render({ selectedCommandId: null, commands: [devCommand] });

    const scope = container.querySelector('[data-testid="scope"]')!;
    expect(document.activeElement).not.toBe(searchInput());

    pressKey(scope, 'f');

    expect(document.activeElement).toBe(searchInput());
  });

  it('selects the active log on cmd+A', () => {
    seedLogs({ [devCommand.id]: makeLog(['hello world']) });
    render({ selectedCommandId: null, commands: [devCommand] });

    const scope = container.querySelector('[data-testid="scope"]')!;
    pressKey(scope, 'a');

    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.getRangeAt(0).commonAncestorContainer).toBe(
      container.querySelector('[data-command-log-content]'),
    );
  });

  it('clears the active tab logs on cmd+K', () => {
    seedLogs({
      [devCommand.id]: makeLog(['hello world']),
      [buildCommand.id]: makeLog(['goodbye moon']),
    });
    render({
      selectedCommandId: buildCommand.id,
      commands: [devCommand, buildCommand],
    });

    const scope = container.querySelector('[data-testid="scope"]')!;
    pressKey(scope, 'k');

    expect(apiMocks.resetLogs).toHaveBeenCalledTimes(1);
    expect(apiMocks.resetLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: TASK_ID,
        runCommandId: buildCommand.id,
      }),
    );
  });

  it('restarts only a configured command on cmd+shift+U', () => {
    seedLogs({
      [devCommand.id]: makeLog(['hello world']),
      // Output of its own, so the virtual tab is actually selectable here
      // rather than silently falling back to the configured command.
      [virtualTab.id]: makeLog(['expo output']),
    });
    render({
      selectedCommandId: virtualTab.id,
      virtualTabs: [virtualTab],
      commands: [devCommand],
    });

    const scope = container.querySelector('[data-testid="scope"]')!;
    // The virtual tab is not a configured command: nothing to restart.
    pressKey(scope, 'u', { shiftKey: true });
    expect(startCommand).not.toHaveBeenCalled();

    render({
      selectedCommandId: devCommand.id,
      virtualTabs: [virtualTab],
      commands: [devCommand],
    });
    pressKey(container.querySelector('[data-testid="scope"]')!, 'u', {
      shiftKey: true,
    });

    expect(startCommand).toHaveBeenCalledWith(devCommand.id);
  });

  it('filters both tabs and log lines by the search query', () => {
    seedLogs({
      [devCommand.id]: makeLog(['hello world', 'unrelated line']),
      [buildCommand.id]: makeLog(['goodbye moon']),
    });
    render({
      selectedCommandId: devCommand.id,
      commands: [devCommand, buildCommand],
    });

    expect(tabNames()).toEqual(['Dev Server', 'Build']);
    expect(logLines()).toEqual(['hello world', 'unrelated line']);

    setSearch('hello');

    expect(tabNames()).toEqual(['Dev Server']);
    expect(logLines()).toEqual(['hello world']);
  });
});
