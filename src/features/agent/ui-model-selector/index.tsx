import { forwardRef, useMemo } from 'react';

import { Select, type SelectOption, type SelectRef } from '@/common/ui/select';
import type { BindingKey } from '@/common/context/keyboard-bindings/types';
import type { ComponentSize } from '@/common/ui/styles';
import type { KeyboardLayer } from '@/common/context/keyboard-bindings';
import type { ModelPreference } from '@shared/types';



import {
  type BackendModelOption,
  CLAUDE_CODE_MODELS,
} from '../ui-backend-selector';

// The Claude model list lives in `ui-backend-selector` — this selector's
// fallback is the same list, not a second copy of it (the copy had drifted and
// still carried a stale `claude-opus-4-5` entry).
const DEFAULT_MODELS: BackendModelOption[] = CLAUDE_CODE_MODELS;

export const ModelSelector = forwardRef<
  SelectRef,
  {
    value: ModelPreference;
    onChange: (model: ModelPreference) => void;
    disabled?: boolean;
    /** Override available models (e.g. based on backend). Falls back to default list. */
    models?: BackendModelOption[];
    shortcut?: BindingKey | BindingKey[];
    shortcutBehavior?: 'cycle' | 'open';
    side?: 'top' | 'bottom';
    className?: string;
    size?: ComponentSize;
    layer?: KeyboardLayer;
  }
>(function ModelSelector(
  {
    value,
    onChange,
    disabled,
    models,
    shortcut,
    shortcutBehavior,
    side,
    className,
    size,
    layer,
  },
  ref,
) {
  const effectiveModels = useMemo(
    () =>
      (models ?? DEFAULT_MODELS).map(
        (m): SelectOption<string> => ({
          value: m.value,
          label: m.label,
          description: m.description,
          group: m.group,
        }),
      ),
    [models],
  );

  return (
    <Select
      ref={ref}
      value={value}
      options={effectiveModels}
      onChange={onChange as (v: string) => void}
      disabled={disabled}
      label="Model"
      shortcut={shortcut}
      shortcutBehavior={shortcutBehavior}
      side={side}
      className={className}
      size={size}
      layer={layer}
    />
  );
});
