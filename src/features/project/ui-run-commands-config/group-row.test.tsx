// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type {
  ProjectCommand,
  ProjectCommandGroup,
  UpdateProjectCommandGroup,
} from '@shared/run-command-types';
import { GroupRow } from '@/features/project/ui-run-commands-config/group-row';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const command: ProjectCommand = {
  id: 'cmd-1',
  projectId: 'project-1',
  name: 'Dev server',
  command: 'pnpm dev',
  ports: [],
  portConflictStrategy: 'prompt',
  portOverrideProvider: 'env',
  portOverrideEnvVar: null,
  portOverrideArgs: null,
  envVars: [],
  confirmBeforeRun: false,
  confirmMessage: null,
  isFavorite: false,
  isHidden: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const group: ProjectCommandGroup = {
  id: 'group-1',
  projectId: 'project-1',
  name: 'Group 1',
  stages: [
    {
      id: 'stage-1',
      entries: [{ commandId: 'cmd-1', waitForExit: false }],
      delayMs: 0,
    },
  ],
  commandIds: ['cmd-1'],
  isFavorite: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

function render({
  overrides,
  onUpdate = vi.fn(),
}: {
  overrides?: Partial<ProjectCommandGroup>;
  onUpdate?: (data: UpdateProjectCommandGroup) => void;
} = {}) {
  act(() => {
    root.render(
      <RootKeyboardBindings>
        <RootOverlay>
          <GroupRow
            sortableId="group:group-1"
            group={{ ...group, ...overrides }}
            commands={[command]}
            onUpdate={onUpdate}
            onDelete={vi.fn()}
          />
        </RootOverlay>
      </RootKeyboardBindings>,
    );
  });
}

function getNameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder="Group name"]',
  );
  if (!input) throw new Error('group name input not found');
  return input;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('GroupRow name editing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('renders an editable (not disabled/readonly) name input', () => {
    render();
    const input = getNameInput();
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('Group 1');
  });

  it('reflects typed characters and persists the trimmed name', () => {
    const onUpdate = vi.fn();
    render({ onUpdate });
    const input = getNameInput();

    // Padded so the assertion below actually proves the trim, rather than
    // passing for any value that happens to round-trip unchanged.
    type(input, '  Boot infra  ');
    expect(getNameInput().value).toBe('  Boot infra  ');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onUpdate).toHaveBeenCalledWith({ name: 'Boot infra' });
  });

  it('does not revert the typed name when a stale server value re-renders', () => {
    const onUpdate = vi.fn();
    render({ onUpdate });
    type(getNameInput(), 'Boot infra');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onUpdate).toHaveBeenCalledWith({ name: 'Boot infra' });

    // An in-flight refetch echoes back a name that is neither what we just
    // saved nor what we started from. The save is newer, so it must win.
    // Re-rendering with the *same* name would not exercise the guard at all:
    // the sync effect keys on `group.name`, so it would simply never re-run.
    render({ onUpdate, overrides: { name: 'Stale name' } });
    expect(getNameInput().value).toBe('Boot infra');
  });

  it('adopts the server name once it settles on the saved value', () => {
    const onUpdate = vi.fn();
    render({ onUpdate });
    type(getNameInput(), 'Boot infra');

    act(() => {
      vi.advanceTimersByTime(600);
    });

    // Server catches up; the field is no longer guarded, so a later external
    // rename (another window) must be picked up rather than ignored forever.
    render({ onUpdate, overrides: { name: 'Boot infra' } });
    render({ onUpdate, overrides: { name: 'Renamed elsewhere' } });
    expect(getNameInput().value).toBe('Renamed elsewhere');
  });

  it('restores the previous name when the field is blanked and blurred', () => {
    const onUpdate = vi.fn();
    render({ onUpdate });
    const input = getNameInput();

    type(input, '   ');
    // React delegates `onBlur` to the bubbling `focusout` event; a raw `blur`
    // event does not reach the handler.
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    // Empty names are not persistable, so nothing should be saved and the
    // field must fall back to the last good name instead of staying blank.
    expect(onUpdate).not.toHaveBeenCalled();
    expect(getNameInput().value).toBe('Group 1');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
