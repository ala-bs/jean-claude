// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiSkillSlotConfig } from '@shared/types';

import { SlotDetail } from '.';

const { useManagedSkillsMock } = vi.hoisted(() => ({
  useManagedSkillsMock: vi.fn(),
}));

vi.mock('@/features/agent/ui-backend-model-preset-picker', () => ({
  BackendModelPresetPicker: ({
    backend,
    model,
    onChange,
  }: {
    backend: 'claude-code' | 'opencode';
    model: string;
    onChange: (selection: {
      backend: 'claude-code' | 'opencode';
      model: string;
      presetId: null;
    }) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onChange({ backend: 'opencode', model: 'anthropic/sonnet', presetId: null })
        }
      >
        Change backend
      </button>
      <button
        type="button"
        onClick={() => onChange({ backend, model, presetId: null })}
      >
        Keep backend
      </button>
    </>
  ),
}));

vi.mock('@/hooks/use-managed-skills', () => ({
  useManagedSkills: useManagedSkillsMock,
}));

vi.mock('@/common/ui/select', () => ({
  Select: ({
    value,
    options,
    label,
  }: {
    value: string;
    options: { value: string }[];
    label: string;
  }) => (
    <div
      data-testid={`${label}-select`}
      data-value={value}
      data-options={JSON.stringify(options)}
    />
  ),
}));

vi.mock('@/common/ui/switch', () => ({ Switch: () => null }));
vi.mock('@/features/agent/ui-thinking-selector', () => ({
  ThinkingSelector: () => null,
}));

describe('SlotDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useManagedSkillsMock.mockReset();
    useManagedSkillsMock.mockReturnValue({ data: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('preserves the selected skill when the backend changes', async () => {
    const config: AiSkillSlotConfig = {
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      skillName: 'work-item-summary',
    };
    const onUpdate = vi.fn();
    flushSync(() =>
      root.render(
        <SlotDetail
          label="Work Item Summary"
          description="Summary"
          config={config}
          enabledBackends={[
            { value: 'claude-code', label: 'Claude Code' },
            { value: 'opencode', label: 'OpenCode' },
          ]}
          onUpdate={onUpdate}
        />,
      ),
    );

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Change backend',
    );
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync(() =>
      root.render(
        <SlotDetail
          label="Work Item Summary"
          description="Summary"
          config={{ ...config }}
          enabledBackends={[
            { value: 'claude-code', label: 'Claude Code' },
            { value: 'opencode', label: 'OpenCode' },
          ]}
          onUpdate={onUpdate}
        />,
      ),
    );

    await vi.waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        backend: 'opencode',
        model: 'anthropic/sonnet',
        thinkingEffort: 'default',
        skillName: 'work-item-summary',
      }),
    );
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

  it('deduplicates same-named skills from multiple sources', () => {
    useManagedSkillsMock.mockReturnValue({
      data: [
        {
          name: 'shared-skill',
          source: 'builtin',
          enabledBackends: { 'claude-code': true },
        },
        {
          name: 'shared-skill',
          source: 'project',
          enabledBackends: { 'claude-code': true },
        },
      ],
    });

    flushSync(() =>
      root.render(
        <SlotDetail
          label="Task Name"
          description="Task name"
          config={{
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
            skillName: 'shared-skill',
          }}
          enabledBackends={[{ value: 'claude-code', label: 'Claude Code' }]}
          onUpdate={vi.fn()}
        />,
      ),
    );

    const skillSelect = container.querySelector('[data-testid="Skill-select"]');
    const options = JSON.parse(
      skillSelect?.getAttribute('data-options') ?? '[]',
    ) as { value: string }[];
    expect(options.filter((option) => option.value === 'shared-skill')).toHaveLength(
      1,
    );
  });

  it('accepts external config after a no-op backend selection', async () => {
    const onUpdate = vi.fn();
    const enabledBackends = [
      { value: 'claude-code' as const, label: 'Claude Code' },
      { value: 'opencode' as const, label: 'OpenCode' },
    ];
    flushSync(() =>
      root.render(
        <SlotDetail
          label="Work Item Summary"
          description="Summary"
          config={{
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
            skillName: 'work-item-summary',
          }}
          enabledBackends={enabledBackends}
          onUpdate={onUpdate}
        />,
      ),
    );

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Keep backend',
    );
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync(() =>
      root.render(
        <SlotDetail
          label="Work Item Summary"
          description="Summary"
          config={{
            backend: 'opencode',
            model: 'anthropic/sonnet',
            thinkingEffort: 'high',
            skillName: 'external-skill',
          }}
          enabledBackends={enabledBackends}
          onUpdate={onUpdate}
        />,
      ),
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
