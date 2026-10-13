// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import type {
  EffectiveProjectModelPolicy,
  ModelProfile,
} from '@shared/model-profiles';

const state = vi.hoisted(() => ({
  profiles: [] as ModelProfile[],
  activeProfileId: null as string | null,
  effectiveProfileId: null as string | null,
  policy: undefined as EffectiveProjectModelPolicy | undefined,
  activate: vi.fn(),
  openOverlay: vi.fn(),
}));

vi.mock('@/hooks/use-model-profiles', () => ({
  useActiveModelProfile: () => ({
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    profile: state.profiles.find(
      (entry) => entry.id === state.activeProfileId,
    ),
    isLoading: false,
  }),
  useEffectiveModelProfile: () => ({
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    effectiveProfileId: state.effectiveProfileId,
    profile: state.profiles.find(
      (entry) => entry.id === (state.effectiveProfileId ?? state.activeProfileId),
    ),
    isLoading: false,
  }),
  useActivateModelProfile: () => ({ mutate: state.activate }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: state.policy }),
}));

vi.mock('@/lib/api', () => ({
  api: { projects: { getEffectivePolicy: vi.fn() } },
}));

vi.mock('@/stores/overlays', () => ({
  useOverlaysStore: (selector: (s: { open: unknown }) => unknown) =>
    selector({ open: state.openOverlay }),
}));

vi.mock('@/common/ui/dropdown', () => ({
  Dropdown: ({
    trigger,
    children,
  }: {
    trigger: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {trigger}
      <div role="menu">{children}</div>
    </div>
  ),
  DropdownItem: ({
    children,
    onClick,
    disabled,
    shortcut,
  }: {
    children: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    shortcut?: string;
  }) => (
    <button role="menuitem" onClick={onClick} disabled={disabled}>
      {children}
      {shortcut ? <span>{shortcut}</span> : null}
    </button>
  ),
  DropdownDivider: () => <hr />,
}));

import { ModelProfileSwitcher } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Revision 1: a role holds its triple inline; presets live inside the profile.
const PROFILES: ModelProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [
      {
        id: 'preset-sonnet',
        name: 'Sonnet high',
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
    ],
    quickPresetIds: ['preset-sonnet'],
    roles: {
      agent: {
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
    },
  },
  {
    id: 'codex',
    name: 'Codex fallback',
    presets: [
      {
        id: 'preset-gpt5',
        name: 'GPT-5 high',
        backend: 'codex',
        model: 'gpt-5',
        thinkingEffort: 'high',
      },
    ],
    quickPresetIds: ['preset-gpt5'],
    roles: {
      agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'high' },
    },
  },
];

describe('ModelProfileSwitcher', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    state.profiles = PROFILES;
    state.activeProfileId = 'anthropic';
    state.effectiveProfileId = null;
    state.policy = undefined;
    state.activate = vi.fn();
    state.openOverlay = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  async function render(projectId?: string) {
    await act(() =>
      root.render(
        <ModelProfileSwitcher
          projectId={projectId ?? null}
          overrideContent={<div data-testid="override-pickers" />}
        />,
      ),
    );
  }

  function menuItems() {
    return Array.from(container.querySelectorAll('button[role="menuitem"]'));
  }

  it('renders the active profile and its resolved model in the trigger', async () => {
    await render();

    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain('Anthropic');
    expect(trigger?.textContent).toContain('sonnet');
    expect(trigger?.textContent).toContain('high');
  });

  it('summarises each profile from its own inline agent triple', async () => {
    await render();

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(
      labels.some(
        (label) => label.includes('Anthropic') && label.includes('sonnet'),
      ),
    ).toBe(true);
    expect(
      labels.some(
        (label) => label.includes('Codex fallback') && label.includes('gpt-5'),
      ),
    ).toBe(true);
  });

  it('follows the newly active profile when the active id changes', async () => {
    state.activeProfileId = 'codex';
    await render();

    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain('Codex fallback');
    expect(trigger?.textContent).toContain('gpt-5');
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Codex fallback');
  });

  it('shows the profile matching the selected step model', async () => {
    await act(() =>
      root.render(
        <ModelProfileSwitcher
          projectId={null}
          stepModel={{
            backend: 'codex',
            model: 'gpt-5',
            thinkingEffort: 'high',
          }}
        />,
      ),
    );

    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain('Codex fallback');
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Codex fallback');
  });

  it('marks the active profile and lists every profile with a shortcut hint', async () => {
    await render();

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Anthropic'))).toBe(true);
    expect(labels.some((label) => label.includes('Codex fallback'))).toBe(true);
    expect(labels.some((label) => label.includes('cmd+alt+1'))).toBe(true);
    expect(labels.some((label) => label.includes('cmd+alt+2'))).toBe(true);
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Anthropic');
  });

  it('activates the profile that is selected', async () => {
    await render();

    const codex = menuItems().find((item) =>
      item.textContent?.includes('Codex fallback'),
    );
    expect(codex).toBeDefined();
    await act(() => (codex as HTMLButtonElement).click());

    expect(state.activate).toHaveBeenCalledWith('codex');
  });

  // Hidden entries make the list silently short; say why.
  it('explains that the list is limited when enforce hides profiles', async () => {
    state.policy = {
      policy: { mode: 'enforce', allowedProfileIds: ['anthropic'] },
      source: 'project',
    };

    await render('project-1');

    expect(document.body.textContent).toContain(
      'Limited to what this project allows',
    );
  });

  it('hides the override entry and hides non-permitted profiles under enforce', async () => {
    state.policy = {
      policy: { mode: 'enforce', allowedProfileIds: ['anthropic'] },
      source: 'file',
      filePath: '/repo/.jean-claude/model-policy.json',
    };

    await render('project-1');

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(
      labels.some((label) => label.includes('Override this step only')),
    ).toBe(false);
    expect(container.querySelector('[data-testid="override-pickers"]')).toBe(
      null,
    );

    expect(labels.some((label) => label.includes('Codex fallback'))).toBe(
      false,
    );
    expect(labels.some((label) => label.includes('Anthropic'))).toBe(true);
  });

  it('hides everything but the pinned profile under enforce', async () => {
    state.policy = {
      policy: { mode: 'enforce', pinnedProfileId: 'codex' },
      source: 'project',
    };

    await render('project-1');

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Codex fallback'))).toBe(true);
    expect(labels.some((label) => label.includes('Anthropic'))).toBe(false);
  });

  it('displays the project-effective profile when the global profile is disallowed', async () => {
    state.policy = {
      policy: { mode: 'enforce', allowedProfileIds: ['codex'] },
      source: 'project',
    };
    state.effectiveProfileId = 'codex';

    await render('project-1');

    const trigger = container.querySelector('button[aria-haspopup="menu"]');
    expect(trigger?.textContent).toContain('Codex fallback');
    expect(container.querySelector('[aria-current="true"]')?.textContent).toContain(
      'Codex fallback',
    );
  });

  it('keeps every profile selectable under prefer', async () => {
    state.policy = {
      policy: { mode: 'prefer', pinnedProfileId: 'codex', allowedProfileIds: ['codex'] },
      source: 'project',
    };

    await render('project-1');

    const items = menuItems();
    const codex = items.find((item) =>
      item.textContent?.includes('Codex fallback'),
    ) as HTMLButtonElement | undefined;
    const anthropic = items.find((item) =>
      item.textContent?.includes('Anthropic'),
    ) as HTMLButtonElement | undefined;
    expect(codex).toBeDefined();
    expect(anthropic).toBeDefined();
    expect(anthropic?.disabled).toBeFalsy();
  });

  // An agent role may follow one of the profile's presets by reference; the
  // summary must resolve through it rather than reading "no triple".
  it('summarises a profile whose agent role follows a preset', async () => {
    state.profiles = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        presets: [
          {
            id: 'preset-opus',
            name: 'Opus max',
            backend: 'claude-code',
            model: 'opus',
            thinkingEffort: 'max',
          },
        ],
        quickPresetIds: ['preset-opus'],
        roles: { agent: { presetId: 'preset-opus' } },
      },
    ];
    state.activeProfileId = 'anthropic';

    await render('project-1');

    expect(document.body.textContent).toContain('opus');
  });

  it('shows every profile rather than an empty menu when the allow-list matches nothing', async () => {
    state.policy = {
      policy: { mode: 'enforce', allowedProfileIds: ['ghost'] },
      source: 'project',
    };

    await render('project-1');

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Anthropic'))).toBe(true);
    expect(labels.some((label) => label.includes('Codex fallback'))).toBe(true);
  });

  it('keeps the override entry when no policy enforces a selection', async () => {
    await render();

    const labels = menuItems().map((item) => item.textContent ?? '');
    expect(
      labels.some((label) => label.includes('Override this step only')),
    ).toBe(true);
    expect(labels.some((label) => label.includes('Edit profiles'))).toBe(true);
  });
});
