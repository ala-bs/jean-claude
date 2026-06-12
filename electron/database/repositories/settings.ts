import {
  DEFAULT_TASK_NOTIFICATION_MODES,
  SETTINGS_DEFINITIONS,
  AppSettings,
  type BackendDefaultModelsSetting,
  type CalendarNotificationsSetting,
  type SummaryModelsSetting,
  type TaskEventNotificationsSetting,
  type TaskNotificationEvent,
  type TaskNotificationMode,
  type ThinkingSettingsSetting,
} from '@shared/types';

import { dbg } from '../../lib/debug';
import { db } from '../index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeSummaryModelsSetting(
  value: unknown,
): SummaryModelsSetting | null {
  if (!isRecord(value) || !isRecord(value.models)) {
    return null;
  }

  const defaults = SETTINGS_DEFINITIONS.summaryModels.defaultValue.models;
  const models = value.models as Record<string, unknown>;

  return {
    models: {
      'claude-code':
        typeof models['claude-code'] === 'string'
          ? models['claude-code']
          : defaults['claude-code'],
      opencode:
        typeof models.opencode === 'string'
          ? models.opencode
          : defaults.opencode,
      codex: typeof models.codex === 'string' ? models.codex : defaults.codex,
    },
  };
}

function normalizeBackendDefaultModelsSetting(
  value: unknown,
): BackendDefaultModelsSetting | null {
  if (!isRecord(value) || !isRecord(value.models)) {
    return null;
  }

  const defaults =
    SETTINGS_DEFINITIONS.backendDefaultModels.defaultValue.models;
  const models = value.models as Record<string, unknown>;

  return {
    models: {
      'claude-code':
        typeof models['claude-code'] === 'string'
          ? models['claude-code']
          : defaults['claude-code'],
      opencode:
        typeof models.opencode === 'string'
          ? models.opencode
          : defaults.opencode,
      codex: typeof models.codex === 'string' ? models.codex : defaults.codex,
    },
  };
}

function normalizeThinkingSettingsSetting(
  value: unknown,
): ThinkingSettingsSetting | null {
  if (!isRecord(value) || !isRecord(value.efforts)) {
    return null;
  }

  const defaults = SETTINGS_DEFINITIONS.thinkingSettings.defaultValue;
  const efforts = value.efforts as Record<string, unknown>;
  const selectedModels = isRecord(value.selectedModels)
    ? (value.selectedModels as Record<string, unknown>)
    : {};

  return {
    efforts: {
      'claude-code': {
        ...defaults.efforts['claude-code'],
        ...(isRecord(efforts['claude-code']) ? efforts['claude-code'] : {}),
      },
      opencode: {
        ...defaults.efforts.opencode,
        ...(isRecord(efforts.opencode) ? efforts.opencode : {}),
      },
      codex: {
        ...defaults.efforts.codex,
        ...(isRecord(efforts.codex) ? efforts.codex : {}),
      },
    },
    selectedModels: {
      'claude-code':
        typeof selectedModels['claude-code'] === 'string'
          ? selectedModels['claude-code']
          : defaults.selectedModels['claude-code'],
      opencode:
        typeof selectedModels.opencode === 'string'
          ? selectedModels.opencode
          : defaults.selectedModels.opencode,
      codex:
        typeof selectedModels.codex === 'string'
          ? selectedModels.codex
          : defaults.selectedModels.codex,
    },
  };
}

function normalizeSettingValue<K extends keyof AppSettings>(
  key: K,
  value: unknown,
): AppSettings[K] | null {
  if (key === 'summaryModels') {
    return normalizeSummaryModelsSetting(value) as AppSettings[K];
  }
  if (key === 'backendDefaultModels') {
    return normalizeBackendDefaultModelsSetting(value) as AppSettings[K];
  }
  if (key === 'thinkingSettings') {
    return normalizeThinkingSettingsSetting(value) as AppSettings[K];
  }
  return null;
}

async function writeSettingValue<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('settings')
    .values({ key, value: JSON.stringify(value), updatedAt: now })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({
        value: JSON.stringify(value),
        updatedAt: now,
      }),
    )
    .execute();
}

function migrateTaskEventNotificationsSetting(
  value: unknown,
): TaskEventNotificationsSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  if (obj.modes && typeof obj.modes === 'object') {
    return null;
  }

  if (
    !('mode' in obj) ||
    !('enabled' in obj) ||
    typeof obj.enabled !== 'object' ||
    obj.enabled === null
  ) {
    return null;
  }

  const enabled = obj.enabled as Record<string, unknown>;
  const mode = obj.mode as TaskNotificationMode;
  const modes = Object.fromEntries(
    (
      Object.keys(DEFAULT_TASK_NOTIFICATION_MODES) as TaskNotificationEvent[]
    ).map((event) => [event, enabled[event] === false ? 'disabled' : mode]),
  ) as Record<TaskNotificationEvent, TaskNotificationMode>;

  return { modes };
}

function normalizeCalendarNotificationsSetting(
  value: unknown,
): CalendarNotificationsSetting | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const obj = value as Record<string, unknown>;
  if (
    typeof obj.showStartWindow === 'boolean' &&
    (obj.meetingJoinTarget === 'web' || obj.meetingJoinTarget === 'app')
  ) {
    return null;
  }

  return {
    ...obj,
    showStartWindow:
      typeof obj.showStartWindow === 'boolean' ? obj.showStartWindow : false,
    meetingJoinTarget:
      obj.meetingJoinTarget === 'web' || obj.meetingJoinTarget === 'app'
        ? obj.meetingJoinTarget
        : 'web',
  } as CalendarNotificationsSetting;
}

export const SettingsRepository = {
  async get<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
    const def = SETTINGS_DEFINITIONS[key];
    const row = await db
      .selectFrom('settings')
      .where('key', '=', key)
      .selectAll()
      .executeTakeFirst();

    if (!row) {
      return def.defaultValue as AppSettings[K];
    }

    try {
      const parsed = JSON.parse(row.value);
      if (key === 'taskEventNotifications') {
        const migrated = migrateTaskEventNotificationsSetting(parsed);
        if (migrated && def.validate(migrated)) {
          return migrated as AppSettings[K];
        }
      }
      if (key === 'calendarNotifications') {
        const normalized = normalizeCalendarNotificationsSetting(parsed);
        if (normalized && def.validate(normalized)) {
          return normalized as AppSettings[K];
        }
      }
      const normalized = normalizeSettingValue(key, parsed);
      if (normalized && def.validate(normalized)) {
        dbg.db('Normalized legacy value for setting "%s"', key);
        await writeSettingValue(key, normalized);
        return normalized;
      }
      if (def.validate(parsed)) {
        return parsed as AppSettings[K];
      }
      dbg.db('Invalid value for setting "%s", using default', key);
      return def.defaultValue as AppSettings[K];
    } catch (e) {
      dbg.db('Failed to parse setting "%s", using default: %O', key, e);
      return def.defaultValue as AppSettings[K];
    }
  },

  async set<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void> {
    if (!SETTINGS_DEFINITIONS[key].validate(value)) {
      throw new Error(`Invalid value for setting "${key}"`);
    }
    await writeSettingValue(key, value);
  },
};
