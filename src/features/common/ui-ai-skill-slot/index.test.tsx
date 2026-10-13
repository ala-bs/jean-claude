// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiSkillSlotConfig, AiSkillSlotKey } from '@shared/types';

import { SlotDetail } from '.';

const { useManagedSkillsMock, useResolvedModelForRoleMock } = vi.hoisted(
  () => ({
    useManagedSkillsMock: vi.fn(),
    useResolvedModelForRoleMock: vi.fn(),
  }),
);

vi.mock('@/hooks/use-managed-skills', () => ({
  useManagedSkills: useManagedSkillsMock,
}));

vi.mock('@/hooks/use-model-profiles', () => ({
  useResolvedModelForRole: useResolvedModelForRoleMock,
}));

vi.mock('@/common/ui/select', () => ({
  Select: ({
    value,
    options,
    label,
    onChange,
  }: {
    value: string;
    options: { value: string }[];
    label: string;
    onChange: (value: string) => void;
  }) => (
    <div
      data-testid={`${label}-select`}
      data-value={value}
      data-options={JSON.stringify(options)}
    >
      <button type="button" onClick={() => onChange('other-skill')}>
        Pick other skill
      </button>
    </div>
  ),
}));

vi.mock('@/common/ui/switch', () => ({ Switch: () => null }));

describe('SlotDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useManagedSkillsMock.mockReset();
    useManagedSkillsMock.mockReturnValue({ data: [] });
    useResolvedModelForRoleMock.mockReset();
    useResolvedModelForRoleMock.mockReturnValue({
      data: {
        backend: 'opencode',
        model: 'openai/gpt-5.1-codex',
        thinkingEffort: 'default',
        source: 'profile',
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function render(
    config: AiSkillSlotConfig | null,
    onUpdate = vi.fn(),
    slotKey: AiSkillSlotKey = 'work-item-summary',
  ) {
    flushSync(() =>
      root.render(
        <SlotDetail
          slotKey={slotKey}
          label="Work Item Summary"
          description="Summary"
          config={config}
          onUpdate={onUpdate}
        />,
      ),
    );
    return onUpdate;
  }

  it('renders no model controls — only the prompt picker', () => {
    render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'high',
      skillName: 'work-item-summary',
    });

    expect(container.querySelector('[data-testid="Skill-select"]')).not.toBe(
      null,
    );
    expect(container.textContent).not.toContain('Thinking');
    expect(container.textContent).not.toContain('Backend');
  });

  it('shows the model the role resolves to, read-only, pointing at Model Profiles', () => {
    render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'high',
      skillName: null,
    });

    expect(useResolvedModelForRoleMock).toHaveBeenCalledWith(
      'work-item-summary',
      undefined,
    );
    expect(container.textContent).toContain('openai/gpt-5.1-codex');
    expect(container.textContent).toContain('Model profiles');
  });

  it('lists skills for the backend the role resolves to, not the stored one', () => {
    render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'high',
      skillName: null,
    });

    expect(useManagedSkillsMock).toHaveBeenCalledWith('opencode', undefined);
  });

  it('saves a skill change without touching the stored model fields', async () => {
    const onUpdate = render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'high',
      skillName: 'work-item-summary',
    });

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Pick other skill',
    );
    flushSync(() =>
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    await vi.waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'high',
        skillName: 'other-skill',
      }),
    );
  });

  it('deduplicates same-named skills from multiple sources', () => {
    useManagedSkillsMock.mockReturnValue({
      data: [
        {
          name: 'shared-skill',
          source: 'builtin',
          enabledBackends: { opencode: true },
        },
        {
          name: 'shared-skill',
          source: 'project',
          enabledBackends: { opencode: true },
        },
      ],
    });

    render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      skillName: 'shared-skill',
    });

    const skillSelect = container.querySelector('[data-testid="Skill-select"]');
    const options = JSON.parse(
      skillSelect?.getAttribute('data-options') ?? '[]',
    ) as { value: string }[];
    expect(
      options.filter((option) => option.value === 'shared-skill'),
    ).toHaveLength(1);
  });

  it('keeps a previously selected skill selectable when it is not available', () => {
    render({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      skillName: 'work-item-summary',
    });

    const skillSelect = container.querySelector('[data-testid="Skill-select"]');
    expect(skillSelect?.getAttribute('data-value')).toBe('work-item-summary');
    const options = JSON.parse(
      skillSelect?.getAttribute('data-options') ?? '[]',
    ) as { value: string; label: string }[];
    expect(options).toContainEqual({
      value: 'work-item-summary',
      label: 'work-item-summary (Previously selected)',
    });
  });

  it('accepts an external config change', async () => {
    const onUpdate = vi.fn();
    render(
      {
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
        skillName: 'work-item-summary',
      },
      onUpdate,
    );
    render(
      {
        backend: 'opencode',
        model: 'anthropic/sonnet',
        thinkingEffort: 'high',
        skillName: 'external-skill',
      },
      onUpdate,
    );

    await vi.waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="Skill-select"]')
          ?.getAttribute('data-value'),
      ).toBe('external-skill'),
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
