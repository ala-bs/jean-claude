// Repo-committed model policy file.
//
// `<repo>/.jean-claude/model-policy.json` lets a team commit a model policy
// that applies to everyone. When present it wins *wholesale* over the per-machine
// `projects.modelPolicy` column — never merged, so a committed policy is
// unambiguous.
//
// A committed policy can only *restrict*; it can never grant a backend the user
// has not enabled or authenticated (callers intersect with `enabledBackends`).
//
// Node-only at runtime (it reads from disk). Import it from the main process;
// the renderer should go through IPC (`projects.getEffectivePolicy`).

import {
  PROJECT_MODEL_POLICY_MODES,
  type ProjectModelPolicy,
  type ProjectModelPolicyMode,
} from './model-profiles';
import type { AgentBackendType } from './agent-backend-types';

/** Path of the policy file relative to the repo root. */
export const MODEL_POLICY_FILE_RELATIVE_PATH = '.jean-claude/model-policy.json';

const AGENT_BACKEND_TYPES: readonly AgentBackendType[] = [
  'claude-code',
  'opencode',
  'codex',
  'copilot',
  'vibe',
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((it) => typeof it === 'string');
}

/**
 * Validates a parsed `model-policy.json` payload.
 */
export function isProjectModelPolicy(
  value: unknown,
): value is ProjectModelPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.mode !== 'string' ||
    !PROJECT_MODEL_POLICY_MODES.includes(
      candidate.mode as ProjectModelPolicyMode,
    )
  ) {
    return false;
  }

  if (candidate.allowedBackends !== undefined) {
    if (!isStringArray(candidate.allowedBackends)) return false;
    if (
      !candidate.allowedBackends.every((backend) =>
        AGENT_BACKEND_TYPES.includes(backend as AgentBackendType),
      )
    ) {
      return false;
    }
  }

  if (
    candidate.allowedProfileIds !== undefined &&
    !isStringArray(candidate.allowedProfileIds)
  ) {
    return false;
  }

  if (
    candidate.pinnedProfileId !== undefined &&
    typeof candidate.pinnedProfileId !== 'string'
  ) {
    return false;
  }

  return true;
}

/**
 * Reads and validates `<cwd>/.jean-claude/model-policy.json`.
 *
 * Resolves `null` when the file is absent, unreadable, or malformed — a broken
 * policy file must never block the app; the DB policy applies instead. This
 * function never throws.
 *
 * `enabledBackends`, when supplied, is intersected with the file's
 * `allowedBackends`: a committed policy can only *restrict*, never grant a
 * backend the user has not enabled (design §8).
 *
 * `readFile` is injectable so this module needs no static `node:fs` import —
 * `shared/` is bundled into the renderer too.
 */
export async function readPolicyFile(
  cwd: string,
  options?: {
    enabledBackends?: AgentBackendType[];
    readFile?: (path: string) => Promise<string>;
  },
): Promise<ProjectModelPolicy | null> {
  const path = `${cwd}/${MODEL_POLICY_FILE_RELATIVE_PATH}`;

  let raw: string;
  try {
    if (options?.readFile) {
      raw = await options.readFile(path);
    } else {
      // Dynamic import keeps `node:fs` out of the renderer bundle.
      const { readFile } = await import('node:fs/promises');
      raw = await readFile(path, 'utf-8');
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isProjectModelPolicy(parsed)) return null;

  const policy: ProjectModelPolicy = { mode: parsed.mode };
  if (parsed.allowedBackends !== undefined) {
    policy.allowedBackends = options?.enabledBackends
      ? parsed.allowedBackends.filter((backend) =>
          options.enabledBackends?.includes(backend),
        )
      : [...parsed.allowedBackends];
  }
  if (parsed.allowedProfileIds !== undefined) {
    policy.allowedProfileIds = [...parsed.allowedProfileIds];
  }
  if (parsed.pinnedProfileId !== undefined) {
    policy.pinnedProfileId = parsed.pinnedProfileId;
  }

  return policy;
}
