/**
 * Resolves any CSS color to `#rrggbb`.
 *
 * The theme tokens are authored in `oklch()`, which xterm's own color parser
 * does not understand — handing it the raw value makes it silently fall back to
 * its default palette. Painting one pixel and reading it back gets the browser
 * to do the conversion, and keeps working if the tokens move to another color
 * space later.
 */
export function resolveCssColor(value: string, fallback: string): string {
  if (!value.trim()) return fallback;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallback;

  // Assigning an unparseable color is a silent no-op rather than a throw, so
  // "unchanged" is the only signal available. Two different sentinels, because
  // a single one would misread a token that genuinely resolves to that color.
  const parsed = ['#ff00ff', '#00ff00'].some((sentinel) => {
    context.fillStyle = sentinel;
    context.fillStyle = value;
    return context.fillStyle !== sentinel;
  });
  if (!parsed) return fallback;

  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * xterm renders with its own inline styles, so the app theme has to be handed
 * over explicitly. Reading the CSS variables keeps it in step with the app
 * instead of hardcoding a second palette that drifts.
 */
export function readThemeFromCss(root: HTMLElement) {
  const styles = getComputedStyle(root);
  const read = (name: string, fallback: string) =>
    resolveCssColor(styles.getPropertyValue(name).trim(), fallback);
  const foreground = read('--color-ink-1', '#e6e6e6');
  return {
    background: read('--color-bg-0', '#0b0b0d'),
    foreground,
    cursor: foreground,
    // xterm accepts 8-digit hex for alpha; the selection must stay translucent
    // or it hides the text underneath it.
    selectionBackground: `${read('--color-acc', '#3b82f6')}55`,
  };
}
