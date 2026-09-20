// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { ModelProfile, ProfilePreset } from '@shared/model-profiles';

const state = vi.hoisted(() => ({
  profiles: [] as ModelProfile[],
  activeProfileId: null as string | null,
  enabledBackends: ['claude-code', 'opencode'] as string[],
  fallbackOrder: [] as string[],
}));

const updateSetting = vi.hoisted(() => vi.fn());
const activateProfile = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-model-profiles', () => ({
  useModelProfilesSetting: () => ({ profiles: state.profiles }),
  useActiveModelProfileId: () => ({ activeProfileId: state.activeProfileId }),
  useActivateModelProfile: () => ({ mutate: activateProfile }),
  // Writes go through this hook so the resolved-model cache is invalidated
  // alongside the setting; the component must not call `useUpdateSetting`
  // directly for profiles.
  useUpdateModelProfiles: () => ({ mutate: updateSetting }),
}));

vi.mock('@/hooks/use-settings', () => ({
  useSetting: (key: string) => ({
    data: key === 'modelFallbackOrder' ? state.fallbackOrder : undefined,
  }),
  useUpdateSetting: () => ({ mutate: updateSetting }),
  useBackendsSetting: () => ({
    data: { enabledBackends: state.enabledBackends },
  }),
}));

// The profile editor must not read the *global* preset list any more: presets
// live on the profile. Leaving the backend-models hook unmocked would fire a
// real IPC query, so stub it to the static per-backend model lists.
vi.mock('@/hooks/use-backend-models', () => ({
  useBackendModels: () => ({ data: undefined, isFetched: true }),
}));

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { ModelFallbackOrderSettings } from '@/features/settings/ui-rate-limit-swap-settings';
import { ModelProfilesSettings } from '.';
import { RootOverlay } from '@/common/context/overlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p1',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: {},
    ...overrides,
  };
}

function profilePreset(
  id: string,
  overrides: Partial<ProfilePreset> = {},
): ProfilePreset {
  return {
    id,
    name: id,
    backend: 'claude-code',
    model: 'sonnet',
    thinkingEffort: 'default',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => {
    root.render(
      <RootKeyboardBindings>
        <RootOverlay>{node}</RootOverlay>
      </RootKeyboardBindings>,
    );
  });
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error('element not found');
  act(() => {
    (element as HTMLElement).click();
  });
}

/**
 * Role editors live in a `Dropdown`, which portals its contents to
 * `document.body`. Query the whole document so a control keeps the same
 * accessible name whether it sits inline or inside the popover.
 */
function queryByLabel(label: string) {
  return document.body.querySelector(`[aria-label="${label}"]`);
}

/**
 * Opens the popover that holds a role's controls. Roles whose controls are
 * already inline (the toggle-only switch) have no summary button.
 */
function openRoleEditor(roleLabel: string) {
  // Only one popover at a time: the flat items are matched by their text, so a
  // second open menu would make those queries ambiguous.
  for (const other of document.body.querySelectorAll(
    'button[aria-expanded="true"][aria-haspopup="menu"]',
  )) {
    if (other.getAttribute('aria-label') !== `${roleLabel} binding summary`) {
      click(other);
    }
  }
  const summary = document.body.querySelector(
    `button[aria-label="${roleLabel} binding summary"]`,
  );
  if (!summary) throw new Error(`no summary button for role "${roleLabel}"`);
  if (summary.getAttribute('aria-expanded') === 'true') return;
  click(summary);
}

/** Every one-click item in the open popover, checkable ones included. */
function menuItems() {
  return [
    ...document.body.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"]',
    ),
  ];
}

function itemLabels() {
  return menuItems().map((item) => item.textContent?.trim());
}

function findItem(text: string) {
  const match = menuItems().find((item) =>
    (item.textContent ?? '').includes(text),
  );
  if (!match) {
    throw new Error(
      `no popover item containing "${text}": ${itemLabels().join(' | ')}`,
    );
  }
  return match;
}

/** The single click the flattened popover is supposed to cost. */
function clickItem(text: string) {
  click(findItem(text));
}

function itemIsChecked(text: string) {
  return findItem(text).getAttribute('aria-checked') === 'true';
}

function summaryText(roleLabel: string) {
  return document.body
    .querySelector(`button[aria-label="${roleLabel} binding summary"]`)
    ?.querySelector('span')
    ?.textContent?.trim();
}

/** The app `Select` renders its trigger in place and its list in a portal. */
function openSelect(label: string) {
  const trigger = document.body.querySelector(
    `button[aria-label="${label}"][aria-haspopup="listbox"]`,
  );
  if (!trigger) throw new Error(`no select trigger for "${label}"`);
  click(trigger);
  const listbox = document.body.querySelector(
    `[role="listbox"][aria-label="${label}"]`,
  );
  if (!listbox) throw new Error(`select "${label}" did not open`);
  return [...listbox.querySelectorAll('[role="option"]')];
}

function optionLabels(options: Element[]) {
  return options.map((option) =>
    option.querySelector('span > span')?.textContent?.trim(),
  );
}

function chooseOption(selectLabel: string, optionLabel: string) {
  const options = openSelect(selectLabel);
  const match = options.find((option) =>
    optionLabels([option]).includes(optionLabel),
  );
  if (!match) {
    throw new Error(
      `option "${optionLabel}" not in "${selectLabel}": ${optionLabels(options).join(', ')}`,
    );
  }
  click(match);
}

function selectedLabel(selectLabel: string) {
  const trigger = document.body.querySelector(
    `button[aria-label="${selectLabel}"][aria-haspopup="listbox"]`,
  );
  return trigger?.querySelector('span > span')?.textContent?.trim();
}

/**
 * React tracks the last value it saw on the DOM node, so assigning `.value`
 * directly would make it skip the change event. Go through the prototype setter
 * like testing-library does.
 */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element instanceof HTMLInputElement) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function lastUpdate<T>(key: string): T {
  const calls = updateSetting.mock.calls.filter(
    ([arg]) => (arg as { key: string }).key === key,
  );
  const call = calls.at(-1);
  if (!call) throw new Error(`no update for setting "${key}"`);
  return (call[0] as { value: T }).value;
}

function lastProfiles() {
  return lastUpdate<ModelProfile[]>('modelProfiles');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state.profiles = [];
  state.activeProfileId = null;
  state.enabledBackends = ['claude-code', 'opencode'];
  state.fallbackOrder = [];
  updateSetting.mockReset();
  activateProfile.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('ModelProfilesSettings', () => {
  // Presets come first: you define a shortcut, then apply it to a role.
  it('renders the preset section above the role list', () => {
    state.profiles = [
      {
        id: 'p1',
        name: 'Anthropic',
        presets: [],
        quickPresetIds: [],
        roles: {},
      },
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    const text = container.textContent ?? '';
    const presetsAt = text.indexOf('Presets of this profile');
    // match the unique subtitle: the bare word "Roles" also appears elsewhere
    const rolesAt = text.indexOf('What each part of the app runs on');
    expect(presetsAt).toBeGreaterThan(-1);
    expect(rolesAt).toBeGreaterThan(-1);
    expect(presetsAt).toBeLessThan(rolesAt);

    // and the copy points the right way
    expect(text).toContain('apply to any role below');
  });

  it('creates a profile that owns its own (empty) preset list', () => {
    render(<ModelProfilesSettings />);

    click(queryByLabel('Add profile'));

    const profiles = lastProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('New profile');
    expect(profiles[0].presets).toEqual([]);
    expect(profiles[0].quickPresetIds).toEqual([]);
    expect(profiles[0].roles).toEqual({});
  });

  it('renames a profile', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    const nameInput = queryByLabel('Profile name') as HTMLInputElement;
    setValue(nameInput, 'Cheap');
    act(() => {
      nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(lastProfiles()[0].name).toBe('Cheap');
  });

  it('deletes a profile', () => {
    state.profiles = [profile(), profile({ id: 'p2', name: 'Codex' })];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    click(queryByLabel('Delete profile Anthropic'));

    expect(lastProfiles().map((entry) => entry.id)).toEqual(['p2']);
  });

  // With no profiles left every role falls through to the app fallback, an
  // `enforce` project cannot start a session at all, and the startup migration
  // regenerates a "Default" on the next launch — silently undoing the delete.
  it('refuses to delete the last profile', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    const button = queryByLabel('Delete profile Anthropic') as
      | HTMLButtonElement
      | null;
    expect(button?.disabled).toBe(true);

    click(button);

    expect(updateSetting).not.toHaveBeenCalled();
  });

  // The whole point of revision 1: a role owns a concrete triple, so deleting a
  // preset can never orphan it.
  it('writes an inline triple when a role is edited', () => {
    state.profiles = [
      profile({
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    clickItem('Custom…');
    expect(lastProfiles()[0].roles.summary).toEqual({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'default',
    });

    // re-render with the persisted binding, then narrow the triple
    state.profiles = [
      profile({
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'default',
          },
          summary: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    chooseOption('Summaries model', 'Haiku');
    expect(lastProfiles()[0].roles.summary).toEqual({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
    });

    state.profiles = [
      profile({
        roles: {
          summary: {
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    chooseOption('Summaries thinking', 'High');
    expect(lastProfiles()[0].roles.summary).toEqual({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'high',
    });
  });

  // Revision 2: a preset is a shared definition, so a role points AT it.
  it('binds a role to the preset by reference, not by copying its triple', () => {
    state.profiles = [
      profile({
        presets: [
          profilePreset('preset-opus', {
            name: 'Deep',
            model: 'opus',
            thinkingEffort: 'high',
          }),
        ],
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    // one click on the preset itself — no mode select, no preset select
    clickItem('Deep');

    expect(lastProfiles()[0].roles.summary).toEqual({
      presetId: 'preset-opus',
    });
  });

  // The whole point of the reference: editing the preset moves every role
  // bound to it.
  it('shows the edited preset on a role bound to it', () => {
    state.profiles = [
      profile({
        presets: [profilePreset('a', { name: 'Fast', model: 'haiku' })],
        roles: { summary: { presetId: 'a' } },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);
    expect(summaryText('Summaries')).toContain('haiku');

    chooseOption('Preset Fast model', 'Opus');
    expect(lastProfiles()[0].presets[0].model).toBe('opus');

    // re-render with the persisted edit: the bound role follows it
    state.profiles = lastProfiles();
    render(<ModelProfilesSettings />);
    expect(summaryText('Summaries')).toContain('opus');
  });

  it('leaves a Custom… inline triple alone when a preset is edited', () => {
    state.profiles = [
      profile({
        presets: [profilePreset('a', { name: 'Fast', model: 'haiku' })],
        roles: {
          summary: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    chooseOption('Preset Fast model', 'Opus');
    state.profiles = lastProfiles();
    render(<ModelProfilesSettings />);

    expect(lastProfiles()[0].roles.summary).toEqual({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'default',
    });
    expect(summaryText('Summaries')).toContain('sonnet');
  });

  // Nothing may dangle: deleting the shared definition inlines it where used.
  it('inlines a deleted preset triple into every role bound to it', () => {
    state.profiles = [
      profile({
        presets: [
          profilePreset('a', { name: 'Fast', model: 'haiku' }),
          profilePreset('b', { name: 'Deep', model: 'opus' }),
        ],
        quickPresetIds: ['a'],
        roles: {
          summary: { presetId: 'a' },
          memory: { presetId: 'b' },
          'pr-review': 'inherit',
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    click(queryByLabel('Delete preset Fast'));

    const next = lastProfiles()[0];
    expect(next.presets.map((preset) => preset.id)).toEqual(['b']);
    expect(next.quickPresetIds).toEqual([]);
    expect(next.roles.summary).toEqual({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
    });
    // untouched
    expect(next.roles.memory).toEqual({ presetId: 'b' });
    expect(next.roles['pr-review']).toBe('inherit');
  });

  // The measured promise of the flattened popover: open, click the preset, done.
  it('applies a preset in a single click and closes the popover', () => {
    state.profiles = [
      profile({
        presets: [
          profilePreset('preset-opus', {
            name: 'Deep',
            model: 'opus',
            thinkingEffort: 'high',
          }),
        ],
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    // click 1 opens the popover
    click(queryByLabel('Summaries binding summary'));
    // click 2 is the preset — and there is nothing in between
    const preset = findItem('Deep');
    expect(preset.textContent).toContain('claude-code / opus · high');
    click(preset);

    expect(lastProfiles()[0].roles.summary).toEqual({
      presetId: 'preset-opus',
    });
    expect(
      queryByLabel('Summaries binding summary')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  // Selection is by id now: an inline triple that happens to equal a preset is
  // still a one-off and must not claim to be that preset.
  it('marks the referenced preset, by id', () => {
    state.profiles = [
      profile({
        presets: [
          profilePreset('a', { name: 'Fast', model: 'haiku' }),
          profilePreset('b', { name: 'Deep', model: 'opus' }),
        ],
        roles: { summary: { presetId: 'b' } },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    expect(itemIsChecked('Deep')).toBe(true);
    expect(itemIsChecked('Fast')).toBe(false);
  });

  it('names the preset a role follows in its summary', () => {
    state.profiles = [
      profile({
        presets: [profilePreset('b', { name: 'Deep', model: 'opus' })],
        roles: { summary: { presetId: 'b' } },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    const summary = summaryText('Summaries') ?? '';
    expect(summary).toContain('Deep');
    expect(summary).toContain('opus');
  });

  it('does not mark a preset an inline triple merely equals', () => {
    state.profiles = [
      profile({
        presets: [profilePreset('b', { name: 'Deep', model: 'opus' })],
        roles: {
          summary: {
            backend: 'claude-code',
            model: 'opus',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    expect(itemIsChecked('Deep')).toBe(false);
  });

  it('points at the preset section when the profile has no presets', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Add a preset above');
  });

  // Was: the options of the (now removed) "Agent binding" select. Same
  // user-visible outcome, read off the flat items instead.
  it('does not offer "off" or "inherit" for the agent role', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Agent');
    const labels = itemLabels();
    expect(labels).toContain('Not set');
    expect(labels.some((label) => label?.includes('Off (disabled)'))).toBe(
      false,
    );
    expect(labels.some((label) => label?.startsWith('Same as Agent'))).toBe(
      false,
    );
  });

  // "Inherit from Agent" said neither which agent nor what you would get.
  it('spells out what inherit resolves to, and names the row it copies', () => {
    state.profiles = [
      profile({
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'opus',
            thinkingEffort: 'high',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    expect(itemLabels()).toContain(
      'Same as Agent row above (claude-code / opus · high)',
    );
  });

  it('says so when the agent role it would inherit from is unset', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Summaries');
    expect(itemLabels()).toContain('Same as Agent row above (not set yet)');
  });

  // Autocomplete is Mistral FIM driven by the Autocomplete settings (own API
  // key and model), so a triple has nothing to contribute there.
  it('renders the toggle-only autocomplete role as a switch, not a model picker', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    const toggle = queryByLabel('Autocomplete') as HTMLButtonElement;
    expect(toggle.getAttribute('role')).toBe('switch');
    // unset means inherit, i.e. enabled
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // `Autocomplete binding` is deliberately not asserted: the role mode
    // Select no longer exists for any role, so that check would pass
    // vacuously and read as coverage it does not provide.
    expect(queryByLabel('Autocomplete model')).toBeNull();
    // and no popover either: the switch is the whole control
    expect(queryByLabel('Autocomplete binding summary')).toBeNull();
  });

  it('turns autocomplete off and back on through the switch', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    click(queryByLabel('Autocomplete'));
    expect(lastProfiles()[0].roles.completion).toBe('off');

    state.profiles = [profile({ roles: { completion: 'off' } })];
    render(<ModelProfilesSettings />);
    expect(
      (queryByLabel('Autocomplete') as HTMLButtonElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('false');

    click(queryByLabel('Autocomplete'));
    expect(lastProfiles()[0].roles.completion).toBe('inherit');
  });

  describe('per-profile presets', () => {
    it('adds a preset to the selected profile only', () => {
      state.profiles = [profile(), profile({ id: 'p2', name: 'Codex' })];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      click(queryByLabel('Add preset'));

      const profiles = lastProfiles();
      expect(profiles[0].presets).toHaveLength(1);
      expect(profiles[0].presets[0]).toMatchObject({
        backend: 'claude-code',
        model: 'default',
        thinkingEffort: 'default',
      });
      expect(profiles[1].presets).toEqual([]);
    });

    it('shows only the selected profile presets', () => {
      state.profiles = [
        profile({ presets: [profilePreset('a', { name: 'Fast' })] }),
        profile({
          id: 'p2',
          name: 'Codex',
          presets: [profilePreset('b', { name: 'Codexy' })],
        }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      expect(queryByLabel('Name for preset Fast')).not.toBeNull();
      expect(queryByLabel('Name for preset Codexy')).toBeNull();
    });

    it('renames, edits and deletes a preset of the selected profile', () => {
      state.profiles = [profile({ presets: [profilePreset('a', { name: 'Fast' })] })];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      const nameInput = queryByLabel('Name for preset Fast') as HTMLInputElement;
      setValue(nameInput, 'Faster');
      act(() => {
        nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(lastProfiles()[0].presets[0].name).toBe('Faster');

      chooseOption('Preset Fast model', 'Haiku');
      expect(lastProfiles()[0].presets[0].model).toBe('haiku');

      click(queryByLabel('Delete preset Fast'));
      expect(lastProfiles()[0].presets).toEqual([]);
    });

    it('toggles a preset in and out of the quick list', () => {
      state.profiles = [
        profile({
          presets: [profilePreset('a', { name: 'Fast' })],
          quickPresetIds: ['a'],
        }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      const star = queryByLabel('Toggle quick list for Fast') as HTMLElement;
      expect(star.getAttribute('aria-pressed')).toBe('true');

      click(star);
      expect(lastProfiles()[0].quickPresetIds).toEqual([]);

      state.profiles = [
        profile({
          presets: [profilePreset('a', { name: 'Fast' })],
          quickPresetIds: [],
        }),
      ];
      render(<ModelProfilesSettings />);
      expect(
        (
          queryByLabel('Toggle quick list for Fast') as HTMLElement
        ).getAttribute('aria-pressed'),
      ).toBe('false');

      click(queryByLabel('Toggle quick list for Fast'));
      expect(lastProfiles()[0].quickPresetIds).toEqual(['a']);
    });
  });

  // A bare preset-id string was the revision-0 shape and resolves to nothing.
  it('never stores a bare preset id string in a role binding', () => {
    state.profiles = [
      profile({ presets: [profilePreset('a', { name: 'Fast' })] }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Agent');
    clickItem('Custom…');
    openRoleEditor('PR review');
    clickItem('Fast');

    expect(lastProfiles()[0].roles['pr-review']).toEqual({ presetId: 'a' });
    for (const call of updateSetting.mock.calls) {
      const value = (call[0] as { key: string; value: ModelProfile[] }).value;
      for (const entry of value) {
        for (const binding of Object.values(entry.roles)) {
          expect(binding).not.toBe('a');
        }
      }
    }
  });

  // `project-logo` can only ever be an OpenAI image model: a (backend, model,
  // thinking) triple was never usable there.
  describe('image roles', () => {
    it('offers no backend, thinking or preset controls', () => {
      state.profiles = [
        profile({ presets: [profilePreset('a', { name: 'Fast' })] }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      // the chat neighbour still offers the preset as a one-click item
      openRoleEditor('Summaries');
      expect(itemLabels().some((label) => label?.startsWith('Fast'))).toBe(
        true,
      );

      openRoleEditor('Project logos');

      expect(queryByLabel('Project logos backend')).toBeNull();
      expect(queryByLabel('Project logos thinking')).toBeNull();
      // presets are chat triples: none of them are offered here
      expect(itemLabels().some((label) => label?.startsWith('Fast'))).toBe(
        false,
      );

      expect(itemLabels()).toEqual([
        'Default (from AI Generation settings)',
        'Off (disabled)',
        'Custom…',
        'Reset to default (Project logos)',
      ]);
    });

    it('writes an imageModel binding', () => {
      state.profiles = [profile()];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Project logos');
      clickItem('Custom…');
      const input = queryByLabel('Project logos image model') as HTMLInputElement;
      setValue(input, 'gpt-image-1');

      expect(lastProfiles()[0].roles['project-logo']).toEqual({
        imageModel: 'gpt-image-1',
      });
    });

    it('rejects a model that is not a gpt-image model', () => {
      state.profiles = [profile()];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Project logos');
      clickItem('Custom…');
      updateSetting.mockClear();

      const input = queryByLabel('Project logos image model') as HTMLInputElement;
      setValue(input, 'sonnet');

      expect(updateSetting).not.toHaveBeenCalled();
      expect(
        document.body.querySelector('[role="alert"]')?.textContent ?? '',
      ).toContain('gpt-image');
    });

    it('turns an image role off', () => {
      state.profiles = [profile()];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Project logos');
      clickItem('Off (disabled)');
      expect(lastProfiles()[0].roles['project-logo']).toBe('off');
    });

    it('goes back to the AI Generation default', () => {
      state.profiles = [
        profile({ roles: { 'project-logo': { imageModel: 'gpt-image-1' } } }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Project logos');
      // a stored image model opens straight onto the revealed text input
      expect(itemIsChecked('Custom…')).toBe(true);
      expect(
        (queryByLabel('Project logos image model') as HTMLInputElement).value,
      ).toBe('gpt-image-1');

      clickItem('Default (from AI Generation settings)');
      expect(lastProfiles()[0].roles['project-logo']).toBeUndefined();
    });
  });

  it('renders the project feature map role like any other chat role', () => {
    state.profiles = [profile()];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Project feature maps');
    expect(itemLabels()).toContain('Custom…');
  });

  it('keeps the selected backend on the triple', () => {
    state.profiles = [
      profile({
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    openRoleEditor('Agent');
    expect(selectedLabel('Agent model')).toBe('Sonnet');

    chooseOption('Agent backend', 'OpenCode');
    expect(lastProfiles()[0].roles.agent).toEqual({
      backend: 'opencode',
      model: 'default',
      thinkingEffort: 'default',
    });
  });

  // Thirteen always-visible rows cannot each carry four selects. The row shows
  // what it resolves to; the controls live one click away.
  describe('role summary popover', () => {
    it('collapses a role to a summary button and hides its controls until opened', () => {
      state.profiles = [
        profile({
          roles: {
            agent: {
              backend: 'claude-code',
              model: 'opus',
              thinkingEffort: 'high',
            },
            summary: {
              backend: 'claude-code',
              model: 'haiku',
              thinkingEffort: 'default',
            },
          },
        }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      expect(summaryText('Summaries')).toBe('claude-code / haiku');
      expect(queryByLabel('Summaries model')).toBeNull();
      expect(menuItems()).toHaveLength(0);

      // a custom triple no preset expresses opens with the selects revealed
      openRoleEditor('Summaries');
      expect(queryByLabel('Summaries model')).not.toBeNull();
      expect(queryByLabel('Summaries backend')).not.toBeNull();
      expect(queryByLabel('Summaries thinking')).not.toBeNull();
    });

    it('summarises inherit, off and an unset agent without opening anything', () => {
      state.profiles = [
        profile({ roles: { 'pr-review': 'off' } }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      expect(summaryText('Agent')).toBe('Not set');
      expect(summaryText('Summaries')).toBe('Same as Agent');
      expect(summaryText('PR review')).toBe('Off');
      expect(summaryText('Project logos')).toBe('Default');
    });

    it('edits the binding from inside the popover', () => {
      state.profiles = [
        profile({
          roles: {
            agent: {
              backend: 'claude-code',
              model: 'opus',
              thinkingEffort: 'high',
            },
          },
        }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Summaries');
      clickItem('Off (disabled)');
      expect(lastProfiles()[0].roles.summary).toBe('off');
    });
  });

  // The override badge was removed: most profiles deliberately set a cheaper
  // model on nearly every role, so it fired on almost every row and marked
  // nothing useful. Assert it stays gone rather than silently creeping back.
  it('does not badge roles as overridden', () => {
    state.profiles = [
      profile({
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'opus',
            thinkingEffort: 'high',
          },
          summary: {
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
          },
        },
      }),
    ];
    state.activeProfileId = 'p1';
    render(<ModelProfilesSettings />);

    expect(queryByLabel('Summaries is overridden')).toBeNull();
    expect(document.body.textContent).not.toContain('override');
  });

  describe('reset to inherit', () => {
    it('puts an overridden role back on inherit in one click', () => {
      state.profiles = [
        profile({
          roles: {
            summary: {
              backend: 'claude-code',
              model: 'haiku',
              thinkingEffort: 'default',
            },
          },
        }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Summaries');
      const reset = [
        ...document.body.querySelectorAll('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes('Reset to inherit (Summaries)'));
      click(reset);

      expect(lastProfiles()[0].roles.summary).toBe('inherit');
    });

    it('offers no reset on the agent role, which has nothing to inherit from', () => {
      state.profiles = [profile()];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Agent');
      const items = [...document.body.querySelectorAll('[role="menuitem"]')];
      expect(
        items.some((item) => item.textContent?.includes('Reset to inherit')),
      ).toBe(false);
    });

    it('resets an image role to the AI Generation default', () => {
      state.profiles = [
        profile({ roles: { 'project-logo': { imageModel: 'gpt-image-1' } } }),
      ];
      state.activeProfileId = 'p1';
      render(<ModelProfilesSettings />);

      openRoleEditor('Project logos');
      const reset = [
        ...document.body.querySelectorAll('[role="menuitem"]'),
      ].find((item) =>
        item.textContent?.includes('Reset to default (Project logos)'),
      );
      click(reset);

      expect(lastProfiles()[0].roles['project-logo']).toBeUndefined();
    });
  });
});

describe('ModelFallbackOrderSettings', () => {
  it('reorders the fallback profiles', () => {
    state.profiles = [profile(), profile({ id: 'p2', name: 'Codex' })];
    state.fallbackOrder = ['p1', 'p2'];
    render(<ModelFallbackOrderSettings />);

    click(queryByLabel('Move Anthropic down'));

    expect(lastUpdate<string[]>('modelFallbackOrder')).toEqual(['p2', 'p1']);
  });

  it('adds and removes profiles from the fallback order', () => {
    state.profiles = [profile(), profile({ id: 'p2', name: 'Codex' })];
    state.fallbackOrder = ['p1'];
    render(<ModelFallbackOrderSettings />);

    const addSelect = queryByLabel(
      'Add profile to fallback order',
    ) as HTMLSelectElement;
    setValue(addSelect, 'p2');
    expect(lastUpdate<string[]>('modelFallbackOrder')).toEqual(['p1', 'p2']);

    click(queryByLabel('Remove Anthropic from fallback order'));
    expect(lastUpdate<string[]>('modelFallbackOrder')).toEqual([]);
  });
});
