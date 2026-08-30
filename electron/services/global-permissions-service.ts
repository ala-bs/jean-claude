import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import writeFileAtomic from 'write-file-atomic';

import type {
  PermissionAction,
  PermissionScope,
  ResolvedPermissionRule,
  ToolPermissionConfig,
} from '../../shared/permission-types';
import { dbg } from '../lib/debug';

import {
  buildToolPermissionConfig,
  flattenScope,
  isUnrestrictedBashPattern,
  normalizeToolRequest,
} from './permission-settings-service';
import { emitPermissionsChanged } from './permission-event-service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GLOBAL_SETTINGS_DIR = path.join(os.homedir(), '.config', 'jean-claude');
const GLOBAL_SETTINGS_FILENAME = 'settings.json';

interface GlobalSettings {
  version: 1;
  permissions: PermissionScope;
}

// ---------------------------------------------------------------------------
// Write Mutex (prevents TOCTOU races on read-modify-write)
// ---------------------------------------------------------------------------

let writeLock = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the existing lock so concurrent calls serialize
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  const previous = writeLock;
  writeLock = next;

  await previous;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

// ---------------------------------------------------------------------------
// In-memory Cache (invalidated on write)
// ---------------------------------------------------------------------------

let cachedPermissions: PermissionScope | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGlobalSettingsPath(): string {
  return path.join(GLOBAL_SETTINGS_DIR, GLOBAL_SETTINGS_FILENAME);
}

/**
 * Returns true if a permission string represents bare "bash" without a
 * specific command. Bare bash must never be allowed.
 */
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<string>(['allow', 'ask', 'deny']);

/**
 * Runtime validation for a PermissionScope object.
 * Rejects bare bash entries and invalid action values.
 */
export function validatePermissionScope(scope: unknown): PermissionScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new Error('Invalid permission scope: must be a plain object');
  }

  const result: PermissionScope = {};
  for (const [tool, config] of Object.entries(
    scope as Record<string, unknown>,
  )) {
    if (typeof config === 'string') {
      if (!VALID_ACTIONS.has(config)) {
        throw new Error(
          `Invalid action "${config}" for tool "${tool}". Must be one of: allow, ask, deny`,
        );
      }
      // Scalar config — check for bare bash (only block "allow")
      if (isUnrestrictedBashPattern(tool, '*') && config === 'allow') {
        throw new Error(
          'Bare "bash" without a command pattern is not allowed globally',
        );
      }
      result[tool] = config as PermissionAction;
    } else if (typeof config === 'object' && config !== null) {
      const patterns: Record<string, PermissionAction> = {};
      for (const [pattern, action] of Object.entries(
        config as Record<string, unknown>,
      )) {
        if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
          throw new Error(
            `Invalid action "${String(action)}" for tool "${tool}" pattern "${pattern}"`,
          );
        }
        if (isUnrestrictedBashPattern(tool, pattern) && action === 'allow') {
          throw new Error(
            'Bare "bash" without a command pattern is not allowed globally',
          );
        }
        patterns[pattern] = action as PermissionAction;
      }
      result[tool] = patterns;
    } else {
      throw new Error(
        `Invalid config for tool "${tool}": must be a string or object`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Last successfully parsed scope. Survives cache invalidation so a transient
 * read/parse failure can fall back to it instead of collapsing to `{}`.
 *
 * Returning `{}` on failure is only correct when the file genuinely does not
 * exist. For any other error the real permissions are *unknown*, and an empty
 * scope is the worst possible guess: `refreshPermissionRules` pushes it into
 * every live agent session as the authoritative global snapshot, so every
 * globally-allowed tool silently drops to `ask`/deny at once.
 */
let lastKnownGoodPermissions: PermissionScope | null = null;

/**
 * Read global permissions from `~/.config/jean-claude/settings.json`.
 * Returns an empty `PermissionScope` only when the file does not exist.
 * On a transient read/parse failure, falls back to the last known good scope.
 * Uses an in-memory cache; invalidated on write.
 */
export async function readGlobalPermissions(): Promise<PermissionScope> {
  if (cachedPermissions) return structuredClone(cachedPermissions);

  let content: string;
  try {
    content = await fs.readFile(getGlobalSettingsPath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // No settings file yet — an empty scope really is the truth.
      cachedPermissions = {};
      // Only seed the fallback on first run. If we already had a good scope,
      // the file vanishing underneath us (synced ~/.config, external cleanup)
      // must not destroy the fallback for later transient failures.
      if (lastKnownGoodPermissions === null) {
        lastKnownGoodPermissions = {};
      } else if (Object.keys(lastKnownGoodPermissions).length > 0) {
        dbg.agentPermission(
          'Global settings file disappeared — keeping last known good scope (%d tools) as fallback',
          Object.keys(lastKnownGoodPermissions).length,
        );
      }
      return {};
    }
    dbg.agentPermission(
      'Failed reading global settings (%O) — reusing last known good scope (%d tools)',
      error,
      Object.keys(lastKnownGoodPermissions ?? {}).length,
    );
    return structuredClone(lastKnownGoodPermissions ?? {});
  }

  try {
    const parsed = JSON.parse(content) as GlobalSettings;
    if (parsed.version !== 1 || !parsed.permissions) {
      dbg.agentPermission(
        'Invalid global settings format — reusing last known good scope (%d tools)',
        Object.keys(lastKnownGoodPermissions ?? {}).length,
      );
      return structuredClone(lastKnownGoodPermissions ?? {});
    }
    cachedPermissions = parsed.permissions;
    lastKnownGoodPermissions = parsed.permissions;
    return structuredClone(parsed.permissions);
  } catch (error) {
    dbg.agentPermission(
      'Failed parsing global settings (%O) — reusing last known good scope (%d tools)',
      error,
      Object.keys(lastKnownGoodPermissions ?? {}).length,
    );
    return structuredClone(lastKnownGoodPermissions ?? {});
  }
}

/**
 * Write global permissions to `~/.config/jean-claude/settings.json`.
 * Creates the directory if it doesn't exist.
 * Validates the scope before writing and sets restrictive file permissions.
 */
export async function writeGlobalPermissions(
  permissions: PermissionScope,
): Promise<void> {
  // Validate before writing
  validatePermissionScope(permissions);

  const settings: GlobalSettings = {
    version: 1,
    permissions,
  };

  await fs.mkdir(GLOBAL_SETTINGS_DIR, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    getGlobalSettingsPath(),
    JSON.stringify(settings, null, 2) + '\n',
    { encoding: 'utf-8', mode: 0o600 },
  );

  // Invalidate cache after write. The fallback must advance with it: leaving it
  // on the pre-write scope would make a failed read immediately after a
  // *revocation* serve the rule the user just removed — wider than both disk
  // and the old fail-to-`ask` behaviour.
  cachedPermissions = null;
  lastKnownGoodPermissions = structuredClone(permissions);

  // Single choke point: every add/remove/edit path writes through here.
  emitPermissionsChanged({ scope: 'global' });
}

// ---------------------------------------------------------------------------
// Add / Remove Rules
// ---------------------------------------------------------------------------

/**
 * Add a permission rule to the global scope.
 *
 * Security: refuses to add bare bash (no command pattern).
 *
 * @returns `true` if the rule was added, `false` if it was rejected (bare bash).
 * @throws if validation or I/O fails.
 */
type AddGlobalPermissionParams = {
  toolName: string;
  input: Record<string, unknown>;
  action?: PermissionAction;
};

export function addGlobalPermission(
  params: AddGlobalPermissionParams,
): Promise<boolean>;
export function addGlobalPermission<T>(
  params: AddGlobalPermissionParams & {
    afterPersisted: () => Promise<T>;
  },
): Promise<T | false>;
export async function addGlobalPermission<T>({
  toolName,
  input,
  action = 'allow',
  afterPersisted,
}: AddGlobalPermissionParams & {
  afterPersisted?: () => Promise<T>;
}): Promise<boolean | T> {
  const { tool, matchValue } = normalizeToolRequest(toolName, input);

  if (isUnrestrictedBashPattern(tool, matchValue) && action === 'allow') {
    dbg.agentPermission(
      'Refusing to allow bare "bash" globally — a specific command pattern is required',
    );
    return false;
  }

  return withWriteLock(async () => {
    const permissions = await readGlobalPermissions();
    const previous = permissions[tool];
    permissions[tool] = buildToolPermissionConfig({
      existing: previous,
      matchValue,
      action,
    });

    await writeGlobalPermissions(permissions);
    try {
      return afterPersisted ? await afterPersisted() : true;
    } catch (error) {
      const current = await readGlobalPermissions();
      if (previous === undefined) delete current[tool];
      else current[tool] = previous;
      await writeGlobalPermissions(current);
      throw error;
    }
  });
}

/**
 * Remove a permission rule from the global scope.
 *
 * If `pattern` is provided, removes only that specific pattern entry from
 * the tool's config. If `pattern` is omitted, removes the entire tool entry.
 */
export async function removeGlobalPermission({
  tool,
  pattern,
}: {
  tool: string;
  pattern?: string;
}): Promise<void> {
  return withWriteLock(async () => {
    const permissions = await readGlobalPermissions();

    if (!pattern) {
      // Remove the entire tool entry
      delete permissions[tool];
    } else {
      const existing = permissions[tool];
      if (typeof existing === 'object' && existing !== null) {
        const config = { ...existing } as Record<string, PermissionAction>;
        delete config[pattern];

        // If no patterns remain, remove the tool entry entirely
        const remaining = Object.keys(config);
        if (remaining.length === 0) {
          delete permissions[tool];
        } else if (remaining.length === 1 && remaining[0] === '*') {
          // Collapse { "*": action } back to scalar
          permissions[tool] = config['*'] as ToolPermissionConfig;
        } else {
          permissions[tool] = config;
        }
      } else {
        // Scalar config — only remove if pattern is '*'
        if (pattern === '*') {
          delete permissions[tool];
        }
      }
    }

    await writeGlobalPermissions(permissions);
  });
}

/**
 * Atomically edit a permission rule: remove the old pattern, then add the new
 * one in a single write-lock so no data is lost if validation fails.
 */
export async function editGlobalPermission({
  tool,
  oldPattern,
  newPattern,
  action,
}: {
  tool: string;
  oldPattern: string | undefined;
  newPattern: string | undefined;
  action: PermissionAction;
}): Promise<void> {
  const newMatchValue = newPattern?.trim() || '';

  if (isUnrestrictedBashPattern(tool, newMatchValue) && action === 'allow') {
    throw new Error(
      'Bare "bash" without a command pattern is not allowed globally',
    );
  }

  return withWriteLock(async () => {
    const permissions = await readGlobalPermissions();

    // 1. Remove old entry (inline logic from removeGlobalPermission)
    const patternChanged = oldPattern !== newPattern;
    if (patternChanged && oldPattern !== undefined) {
      const existing = permissions[tool];
      if (typeof existing === 'object' && existing !== null) {
        const config = { ...existing } as Record<string, PermissionAction>;
        delete config[oldPattern];
        const remaining = Object.keys(config);
        if (remaining.length === 0) {
          delete permissions[tool];
        } else if (remaining.length === 1 && remaining[0] === '*') {
          permissions[tool] = config['*'] as ToolPermissionConfig;
        } else {
          permissions[tool] = config;
        }
      } else if (oldPattern === '*') {
        delete permissions[tool];
      }
    }

    // 2. Add new entry
    permissions[tool] = buildToolPermissionConfig({
      existing: permissions[tool],
      matchValue: newMatchValue,
      action,
    });

    await writeGlobalPermissions(permissions);
  });
}

// ---------------------------------------------------------------------------
// Rule Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve global permissions into a flat list of `ResolvedPermissionRule[]`.
 */
export async function resolveGlobalRules(): Promise<ResolvedPermissionRule[]> {
  const permissions = await readGlobalPermissions();
  return flattenScope(permissions);
}
