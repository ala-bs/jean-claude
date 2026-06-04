import { Moon, Sun } from 'lucide-react';

import { Button } from '@/common/ui/button';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function ThemeToggle() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const isLight = colorScheme === 'light';

  return (
    <Button
      variant="ghost"
      size="sm"
      icon={isLight ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      onClick={() => setColorScheme(isLight ? 'dark' : 'light')}
      className="text-ink-2 hover:text-ink-0 shrink-0"
    />
  );
}
