import clsx from 'clsx';

import type { BindingKey } from '../../context/keyboard-bindings/types';
import { formatKeyForDisplay } from '../../context/keyboard-bindings/utils';
import {
  getLayoutAwareDigit,
  useKeyboardLayout,
} from '../../context/keyboard-layout';

export function Kbd({
  shortcut,
  className,
  variant = 'default',
}: {
  shortcut: BindingKey;
  className?: string;
  /** White key cap for shortcuts on saturated accent buttons */
  variant?: 'default' | 'on-accent';
}) {
  const layoutMap = useKeyboardLayout();

  // Format the key, replacing digits with layout-aware versions
  let display = formatKeyForDisplay(shortcut);

  // Replace digit display with layout-aware digits
  if (layoutMap) {
    display = display.replace(/[0-9]/g, (digit) =>
      getLayoutAwareDigit(layoutMap, digit).toUpperCase(),
    );
  }

  return (
    <kbd
      className={clsx(
        'rounded border px-1.5 py-0.5 font-mono text-[10px]',
        variant === 'on-accent'
          ? 'border-[color:var(--theme-kbd-on-saturated-border)] bg-[color:var(--theme-kbd-on-saturated-bg)] text-[color:var(--theme-kbd-on-saturated-fg)]'
          : 'border-glass-border bg-bg-1/50 text-ink-3',
        className,
      )}
    >
      {display}
    </kbd>
  );
}
