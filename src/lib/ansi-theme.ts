/** Maps Anser CSS class names to theme CSS variables (see themes/*.css). */
const ANSI_CLASS_TO_VAR: Record<string, string> = {
  'ansi-black': '--theme-ansi-black',
  'ansi-red': '--theme-ansi-red',
  'ansi-green': '--theme-ansi-green',
  'ansi-yellow': '--theme-ansi-yellow',
  'ansi-blue': '--theme-ansi-blue',
  'ansi-magenta': '--theme-ansi-magenta',
  'ansi-cyan': '--theme-ansi-cyan',
  'ansi-white': '--theme-ansi-white',
  'ansi-bright-black': '--theme-ansi-bright-black',
  'ansi-bright-red': '--theme-ansi-bright-red',
  'ansi-bright-green': '--theme-ansi-bright-green',
  'ansi-bright-yellow': '--theme-ansi-bright-yellow',
  'ansi-bright-blue': '--theme-ansi-bright-blue',
  'ansi-bright-magenta': '--theme-ansi-bright-magenta',
  'ansi-bright-cyan': '--theme-ansi-bright-cyan',
  'ansi-bright-white': '--theme-ansi-bright-white',
};

export function ansiClassToThemeColor(className: string): string | undefined {
  const token = ANSI_CLASS_TO_VAR[className];
  return token ? `var(${token})` : undefined;
}
