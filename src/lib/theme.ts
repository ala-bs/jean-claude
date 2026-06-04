export type ColorScheme = 'light' | 'dark';

export type ShikiTheme = 'github-dark' | 'github-light';

export function getShikiTheme(scheme: ColorScheme): ShikiTheme {
  return scheme === 'light' ? 'github-light' : 'github-dark';
}

export function applyColorScheme(scheme: ColorScheme) {
  document.documentElement.dataset.theme = scheme;
}

export function readPersistedColorScheme(): ColorScheme | null {
  try {
    const raw = localStorage.getItem('ui-store');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { settings?: { colorScheme?: unknown } };
    };
    const scheme = parsed.state?.settings?.colorScheme;
    return scheme === 'light' || scheme === 'dark' ? scheme : null;
  } catch {
    return null;
  }
}
