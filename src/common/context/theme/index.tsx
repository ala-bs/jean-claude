import { useEffect } from 'react';

import { applyColorScheme } from '@/lib/theme';
import { useUIStore } from '@/stores/ui';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const colorScheme = useUIStore((s) => s.settings.colorScheme);

  useEffect(() => {
    applyColorScheme(colorScheme);
  }, [colorScheme]);

  return children;
}
