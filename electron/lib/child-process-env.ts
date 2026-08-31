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

/**
 * Stable identity for a set of env overrides.
 *
 * Backends that pool a long-lived child process (Codex app-server, Vibe ACP)
 * keep one process per distinct key, so two projects with different env never
 * share a process — and two projects with identical env still share one.
 *
 * SECURITY: the returned key embeds env *values*, which may be decrypted
 * secrets. Use it only as an in-memory Map key — never log it, persist it, or
 * include it in an error message.
 */
export function getEnvPoolKey(overrides?: Record<string, string>): string {
  if (!overrides) return '';
  const entries = Object.entries(overrides).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) return '';
  return JSON.stringify(entries);
}
