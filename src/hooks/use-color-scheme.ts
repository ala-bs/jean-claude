import { useCallback } from 'react';

import {
  applyColorScheme,
  getShikiTheme,
  type ColorScheme,
  type ShikiTheme,
} from '@/lib/theme';
import { useUIStore } from '@/stores/ui';

export function useColorScheme(): {
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;
  shikiTheme: ShikiTheme;
} {
  const colorScheme = useUIStore((s) => s.settings.colorScheme);
  const setSetting = useUIStore((s) => s.setSetting);

  const setColorScheme = useCallback(
    (scheme: ColorScheme) => {
      setSetting('colorScheme', scheme);
      applyColorScheme(scheme);
    },
    [setSetting],
  );

  return {
    colorScheme,
    setColorScheme,
    shikiTheme: getShikiTheme(colorScheme),
  };
}
