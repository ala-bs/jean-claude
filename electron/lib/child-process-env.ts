const BLOCKED_ENV_NAMES = new Set(['NODE_ENV']);
const BLOCKED_ENV_PREFIXES = ['ELECTRON_', 'JC_'];

export function getChildProcessEnv(
  {
    inheritedEnv = process.env,
    overrides,
  }: {
    inheritedEnv?: NodeJS.ProcessEnv;
    overrides?: Record<string, string>;
  } = {},
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(inheritedEnv)) {
    const normalizedKey = key.toUpperCase();
    if (
      value === undefined ||
      BLOCKED_ENV_NAMES.has(normalizedKey) ||
      BLOCKED_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
    ) {
      continue;
    }
    env[key] = value;
  }

  return { ...env, ...overrides };
}
