import type { PromptPart } from './agent-backend-types';

export type PromptPrefacePlacement = 'before' | 'after';
export type PromptPrefaceFrequency = 'initial' | 'each';

export interface PromptPrefaceSetting {
  text: string;
  placement: PromptPrefacePlacement;
  frequency: PromptPrefaceFrequency;
}

export interface ProjectPromptPrefaceSetting extends PromptPrefaceSetting {
  mode: 'inherit' | 'extend' | 'override';
}

export const DEFAULT_PROMPT_PREFACE_SETTING: PromptPrefaceSetting = {
  text: '',
  placement: 'before',
  frequency: 'initial',
};

export const DEFAULT_PROJECT_PROMPT_PREFACE_SETTING: ProjectPromptPrefaceSetting =
  {
    ...DEFAULT_PROMPT_PREFACE_SETTING,
    mode: 'inherit',
  };

export function isPromptPrefaceSetting(
  value: unknown,
): value is PromptPrefaceSetting {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.text === 'string' &&
    (obj.placement === 'before' || obj.placement === 'after') &&
    (obj.frequency === 'initial' || obj.frequency === 'each')
  );
}

export function isProjectPromptPrefaceSetting(
  value: unknown,
): value is ProjectPromptPrefaceSetting {
  if (!isPromptPrefaceSetting(value)) return false;
  const obj = value as unknown as Record<string, unknown>;
  return (
    obj.mode === 'inherit' || obj.mode === 'extend' || obj.mode === 'override'
  );
}

export function applyPromptPrefaceToParts({
  parts,
  preface,
}: {
  parts: PromptPart[];
  preface: PromptPrefaceSetting;
}): PromptPart[] {
  const prefaceText = preface.text.trim();
  if (!prefaceText) return parts;

  const textIndex = parts.findIndex((part) => part.type === 'text');
  if (textIndex === -1) {
    return preface.placement === 'before'
      ? [{ type: 'text', text: prefaceText }, ...parts]
      : [...parts, { type: 'text', text: prefaceText }];
  }

  return parts.map((part, index) => {
    if (index !== textIndex || part.type !== 'text') return part;
    return {
      ...part,
      text:
        preface.placement === 'before'
          ? `${prefaceText}\n\n${part.text}`
          : `${part.text}\n\n${prefaceText}`,
    };
  });
}
