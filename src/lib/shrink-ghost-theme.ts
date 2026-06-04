/** Read shrink-to-target ghost styles from active theme CSS variables. */
export function getShrinkGhostThemeStyles(): {
  initial: {
    border: string;
    background: string;
    boxShadow: string;
  };
  squircle: {
    border: string;
    background: string;
    boxShadow: string;
  };
  fly: {
    boxShadow: string;
  };
} {
  const root = document.documentElement;
  const get = (name: string) =>
    getComputedStyle(root).getPropertyValue(name).trim();

  return {
    initial: {
      border: `1px solid ${get('--theme-shrink-ghost-border')}`,
      background: get('--theme-shrink-ghost-bg'),
      boxShadow: get('--theme-shrink-ghost-shadow'),
    },
    squircle: {
      border: `1px solid ${get('--theme-shrink-ghost-squircle-border')}`,
      background: get('--theme-shrink-ghost-squircle-bg'),
      boxShadow: get('--theme-shrink-ghost-squircle-glow'),
    },
    fly: {
      boxShadow: get('--theme-shrink-ghost-fly-glow'),
    },
  };
}
