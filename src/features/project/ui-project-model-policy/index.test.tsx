// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ModelProfile,
  ProjectModelPolicy,
  ProjectModelPolicySource,
} from '@shared/model-profiles';

import { act } from 'react';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { ProjectModelPolicyEditor } from '@/features/project/ui-project-model-policy';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILES: ModelProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: {},
  },
  {
    id: 'codex',
    name: 'Codex fallback',
    presets: [],
    quickPresetIds: [],
    roles: {},
  },
];

const BACKENDS: { value: AgentBackendType; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

function render({
  policy,
  source = 'project',
  filePath,
}: {
  policy: ProjectModelPolicy;
  source?: ProjectModelPolicySource;
  filePath?: string;
}) {
  act(() => {
    root.render(
      <RootKeyboardBindings>
        <RootOverlay>
          <ProjectModelPolicyEditor
            policy={policy}
            source={source}
            filePath={filePath}
            profiles={PROFILES}
            enabledBackends={BACKENDS}
            onChange={onChange}
          />
        </RootOverlay>
      </RootKeyboardBindings>,
    );
  });
}

// `Select` portals its listbox, so scope lookups to the document rather than
// the render container.
function byLabel(label: string) {
  return document.body.querySelector(`[aria-label="${label}"]`);
}

function click(element: Element | null | undefined) {
  expect(element, 'element to click exists').toBeTruthy();
  act(() => {
    (element as HTMLElement).click();
  });
}

/** Drive the atomic `Select`: open the trigger, then click the option. */
function selectValue(label: string, optionLabel: string) {
  const trigger = byLabel(label);
  expect(trigger, `select "${label}" exists`).toBeTruthy();
  click(trigger);
  const option = [
    ...document.body.querySelectorAll('[role="option"]'),
  ].find((node) => node.textContent?.trim().startsWith(optionLabel));
  expect(option, `option "${optionLabel}" exists`).toBeTruthy();
  click(option);
}

function outcome() {
  return byLabel('Model policy outcome')?.textContent ?? '';
}

function lastPolicy(): ProjectModelPolicy {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

beforeEach(() => {
  onChange.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ProjectModelPolicyEditor', () => {
  it('shows no constraint fields under inherit', () => {
    render({ policy: { mode: 'inherit' } });

    expect(byLabel('Policy mode')).toBeTruthy();
    expect(byLabel('Profile constraint')).toBeNull();
    expect(byLabel('Backend constraint')).toBeNull();
    expect(byLabel('Default profile')).toBeNull();
    expect(byLabel('Allow Claude Code')).toBeNull();
    expect(byLabel('Allow profile Anthropic')).toBeNull();
    expect(outcome()).toContain('Follows the globally active profile');
  });

  it('renders only the profile picker under prefer', () => {
    render({ policy: { mode: 'prefer', pinnedProfileId: 'codex' } });

    expect(byLabel('Default profile')).toBeTruthy();
    // The resolver ignores allowedBackends/allowedProfileIds outside enforce,
    // so those controls must not be offered here.
    expect(byLabel('Allow Claude Code')).toBeNull();
    expect(byLabel('Allow profile Anthropic')).toBeNull();
    expect(byLabel('Allow all enabled backends')).toBeNull();
    expect(outcome()).toContain('New tasks start on Codex fallback');
    expect(outcome()).toContain('can still switch');
  });

  it('drops the enforce-only fields when switching to prefer', () => {
    render({
      policy: {
        mode: 'enforce',
        allowedBackends: ['claude-code'],
        allowedProfileIds: ['anthropic'],
      },
    });

    selectValue('Policy mode', 'Use a project default profile');

    expect(lastPolicy()).toEqual({ mode: 'prefer' });
  });

  it('explains when a preferred profile no longer exists', () => {
    render({ policy: { mode: 'prefer', pinnedProfileId: 'deleted' } });

    expect(outcome()).toContain('configured project default is unavailable');
    expect(outcome()).toContain('globally active profile');
    expect(outcome()).not.toContain('New tasks start on deleted');
  });

  it('drops every field when switching back to inherit', () => {
    render({
      policy: {
        mode: 'enforce',
        allowedBackends: ['claude-code'],
        allowedProfileIds: ['anthropic'],
        pinnedProfileId: 'anthropic',
      },
    });

    selectValue('Policy mode', 'Use whatever profile is active');

    expect(lastPolicy()).toEqual({ mode: 'inherit' });
  });

  it('enforces with no stored constraints until one is chosen', () => {
    render({ policy: { mode: 'inherit' } });

    selectValue('Policy mode', 'Restrict this project');

    expect(lastPolicy()).toEqual({ mode: 'enforce' });
  });

  describe('backend constraint', () => {
    it('deletes allowedBackends when "all enabled backends" is chosen', () => {
      render({ policy: { mode: 'enforce', allowedBackends: ['claude-code'] } });

      selectValue('Backend constraint', 'All enabled backends');

      const next = lastPolicy();
      expect(next).toEqual({ mode: 'enforce' });
      expect('allowedBackends' in next).toBe(false);

      // The policy is controlled by the parent: feed the emitted value back to
      // check the outcome sentence stops claiming a backend restriction.
      render({ policy: next });
      expect(outcome()).not.toContain('Backends are limited');
    });

    it('seeds the "only these" list with every enabled backend', () => {
      render({ policy: { mode: 'enforce' } });

      expect(byLabel('Allow Claude Code')).toBeNull();
      selectValue('Backend constraint', 'Only these backends');

      expect(lastPolicy()).toEqual({
        mode: 'enforce',
        allowedBackends: ['claude-code', 'codex'],
      });
    });

    it('refuses to empty the "only these" backend list', () => {
      render({ policy: { mode: 'enforce', allowedBackends: ['claude-code'] } });

      click(byLabel('Allow Claude Code'));

      expect(onChange).not.toHaveBeenCalled();
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'at least one backend',
      );
    });

    it('toggles an extra backend on', () => {
      render({ policy: { mode: 'enforce', allowedBackends: ['claude-code'] } });

      click(byLabel('Allow Codex'));

      expect(lastPolicy()).toEqual({
        mode: 'enforce',
        allowedBackends: ['claude-code', 'codex'],
      });
    });
  });

  describe('profile constraint', () => {
    it('clears allowedProfileIds when pinning a profile', () => {
      render({
        policy: { mode: 'enforce', allowedProfileIds: ['anthropic', 'codex'] },
      });

      selectValue('Profile constraint', 'Always run one profile');

      const next = lastPolicy();
      expect(next).toEqual({ mode: 'enforce', pinnedProfileId: 'anthropic' });
      expect('allowedProfileIds' in next).toBe(false);
    });

    it('clears pinnedProfileId when switching to an allowed list', () => {
      render({ policy: { mode: 'enforce', pinnedProfileId: 'codex' } });

      selectValue('Profile constraint', 'Only these profiles');

      const next = lastPolicy();
      expect(next).toEqual({
        mode: 'enforce',
        allowedProfileIds: ['anthropic', 'codex'],
      });
      expect('pinnedProfileId' in next).toBe(false);
    });

    // The other direction of the same invariant. Without it you can store
    // "only these profiles" AND "always run X" at once, which is the
    // contradictory state the old panel happily displayed.
    it('clears allowedProfileIds when a profile is pinned', () => {
      // Start from the contradictory state the old panel could store: an
      // allow-list AND a pin at the same time.
      render({
        policy: {
          mode: 'enforce',
          allowedProfileIds: ['anthropic'],
          pinnedProfileId: 'anthropic',
        },
      });

      selectValue('Pinned model profile', 'Codex fallback');

      const next = lastPolicy();
      expect(next.pinnedProfileId).toBe('codex');
      expect('allowedProfileIds' in next).toBe(false);
    });

    it('drops both keys when any profile is allowed', () => {
      render({ policy: { mode: 'enforce', allowedProfileIds: ['codex'] } });

      selectValue('Profile constraint', 'Any profile');

      expect(lastPolicy()).toEqual({ mode: 'enforce' });
    });

    it('refuses to empty the "only these" profile list', () => {
      render({ policy: { mode: 'enforce', allowedProfileIds: ['codex'] } });

      click(byLabel('Allow profile Codex fallback'));

      expect(onChange).not.toHaveBeenCalled();
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'at least one profile',
      );
    });

    it('keeps allowed profiles in the app-defined profile order', () => {
      render({ policy: { mode: 'enforce', allowedProfileIds: ['codex'] } });

      click(byLabel('Allow profile Anthropic'));

      expect(lastPolicy().allowedProfileIds).toEqual(['anthropic', 'codex']);
    });

    it('changes the pinned profile through the picker', () => {
      render({ policy: { mode: 'enforce', pinnedProfileId: 'anthropic' } });

      selectValue('Pinned model profile', 'Codex fallback');

      expect(lastPolicy()).toEqual({
        mode: 'enforce',
        pinnedProfileId: 'codex',
      });
    });
  });

  describe('outcome sentence', () => {
    it('describes an enforced pin', () => {
      render({ policy: { mode: 'enforce', pinnedProfileId: 'codex' } });

      expect(outcome()).toContain('Always runs Codex fallback');
      expect(outcome()).toContain('refused when a session starts');
    });

    it('describes an enforced allow-list plus backend restriction', () => {
      render({
        policy: {
          mode: 'enforce',
          allowedProfileIds: ['anthropic', 'codex'],
          allowedBackends: ['claude-code'],
        },
      });

      expect(outcome()).toContain('Only Anthropic, Codex fallback may run here');
      expect(outcome()).toContain('Backends are limited to Claude Code');
    });
  });

  it('renders read-only with a source note when the repo policy file exists', () => {
    render({
      policy: {
        mode: 'enforce',
        allowedBackends: ['claude-code'],
        pinnedProfileId: 'anthropic',
      },
      source: 'file',
      filePath: '/repo/.jean-claude/model-policy.json',
    });

    expect(container.textContent).toContain('.jean-claude/model-policy.json');
    expect((byLabel('Policy mode') as HTMLButtonElement).disabled).toBe(true);
    expect((byLabel('Pinned model profile') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((byLabel('Allow Codex') as HTMLInputElement).disabled).toBe(true);
    expect((byLabel('Backend constraint') as HTMLButtonElement).disabled).toBe(
      true,
    );

    click(byLabel('Allow Codex'));
    // Disabled `Select`s must not even open, so there is no option to choose.
    click(byLabel('Policy mode'));
    click(byLabel('Profile constraint'));
    expect(document.body.querySelector('[role="option"]')).toBeNull();
    // The profile picker is a disabled `Select`: clicking must not even open
    // its listbox, so there is no option to choose.
    click(byLabel('Pinned model profile'));
    expect(document.body.querySelector('[role="option"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
