import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS,
  type WorkItemDisplayConfig,
} from '@shared/work-item-display-config-types';
import {
  STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {} as Record<string, unknown>,
}));

vi.mock('../index', () => ({ db: dbMock }));

import {
  ProjectRepository,
  parseProjectModelPolicy,
  parseWorkItemDisplayConfig,
  parseWorkItemTitleParser,
  serializeProjectModelPolicy,
  serializeWorkItemDisplayConfig,
  serializeWorkItemDisplayConfigUpdate,
  serializeWorkItemTitleParser,
  serializeWorkItemTitleParserUpdate,
} from './projects';

describe('project model policy persistence', () => {
  function stubUpdate(rowOverrides: Record<string, unknown> = {}) {
    const captured: { set?: Record<string, unknown>; id?: string } = {};
    const builder = {
      set: (values: Record<string, unknown>) => {
        captured.set = values;
        return builder;
      },
      where: (_col: string, _op: string, value: string) => {
        captured.id = value;
        return builder;
      },
      returningAll: () => builder,
      executeTakeFirstOrThrow: () =>
        Promise.resolve({
          id: captured.id,
          workItemDisplayConfig: null,
          modelPolicy: captured.set?.modelPolicy ?? null,
          ...rowOverrides,
        }),
    };
    dbMock.updateTable = () => builder;
    return captured;
  }

  afterEach(() => {
    delete dbMock.updateTable;
  });

  it('round trips a policy through setModelPolicy', async () => {
    const policy = {
      mode: 'enforce' as const,
      allowedBackends: ['claude-code' as const],
      allowedPresetIds: ['preset-a'],
      pinnedProfileId: 'profile-a',
    };
    const captured = stubUpdate();

    const project = await ProjectRepository.setModelPolicy('p1', policy);

    expect(captured.id).toBe('p1');
    expect(captured.set?.modelPolicy).toBe(JSON.stringify(policy));
    expect(project.modelPolicy).toEqual(policy);
  });

  it('reads a null column as inherit', async () => {
    stubUpdate({ modelPolicy: null });

    const project = await ProjectRepository.setModelPolicy('p1', {
      mode: 'inherit',
    });

    expect(project.modelPolicy).toEqual({ mode: 'inherit' });
  });

  it('falls back to inherit for malformed or invalid JSON', () => {
    expect(parseProjectModelPolicy(null)).toEqual({ mode: 'inherit' });
    expect(parseProjectModelPolicy('{ not json')).toEqual({ mode: 'inherit' });
    expect(parseProjectModelPolicy('{"mode":"nope"}')).toEqual({
      mode: 'inherit',
    });
    expect(parseProjectModelPolicy('[]')).toEqual({ mode: 'inherit' });
    expect(
      parseProjectModelPolicy('{"mode":"prefer","allowedBackends":"x"}'),
    ).toEqual({ mode: 'inherit' });
  });

  it('serializes a policy to JSON', () => {
    expect(serializeProjectModelPolicy({ mode: 'prefer' })).toBe(
      '{"mode":"prefer"}',
    );
  });
});

describe('project work item title parser persistence', () => {
  it('serializes and parses a valid setting', () => {
    const serialized = serializeWorkItemTitleParser(
      STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
    );

    expect(serialized).toBe(
      JSON.stringify(STARTER_WORK_ITEM_TITLE_PARSER_SETTING),
    );
    expect(parseWorkItemTitleParser(serialized)).toEqual(
      STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
    );
  });

  it.each(['{', '{}', '{"version":2,"enabled":false,"rules":[]}'])(
    'falls back to null for malformed or invalid JSON: %s',
    (value) => {
      expect(parseWorkItemTitleParser(value)).toBeNull();
    },
  );

  it('rejects invalid non-null writes', () => {
    const invalid = {
      ...STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
      version: 2,
    } as unknown as WorkItemTitleParserSetting;

    expect(() => serializeWorkItemTitleParser(invalid)).toThrow(
      'Invalid work item title parser setting',
    );
  });

  it('round trips null', () => {
    expect(serializeWorkItemTitleParser(null)).toBeNull();
    expect(parseWorkItemTitleParser(null)).toBeNull();
    expect(serializeWorkItemTitleParserUpdate(null)).toEqual({
      workItemTitleParser: null,
    });
  });

  it('omits undefined updates', () => {
    expect(serializeWorkItemTitleParserUpdate(undefined)).toEqual({});
  });
});

describe('project work item display config persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round trips a valid config through save and read', () => {
    const config: WorkItemDisplayConfig = {
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      overridesByType: {
        Bug: {
          rows: [{ refName: 'System.State', visible: false }],
          tabs: [{ id: 'reproSteps', visible: true }],
        },
      },
    };

    const serialized = serializeWorkItemDisplayConfig(config);

    expect(serialized).toBe(JSON.stringify(config));
    expect(parseWorkItemDisplayConfig(serialized)).toEqual(config);
  });

  it('returns null and warns for corrupt JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseWorkItemDisplayConfig('{ not json')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns for guard-failing JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const badRefName = JSON.stringify({
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      detail: {
        ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail,
        rows: [{ refName: 'System.Bad-Name!', visible: true }],
      },
    });
    const tooManyRows = JSON.stringify({
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      board: {
        rows: Array.from(
          { length: WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS + 1 },
          (_, index) => ({ refName: `Custom.Field${index}`, visible: true }),
        ),
      },
    });

    expect(parseWorkItemDisplayConfig(badRefName)).toBeNull();
    expect(parseWorkItemDisplayConfig(tooManyRows)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('round trips null', () => {
    expect(serializeWorkItemDisplayConfig(null)).toBeNull();
    expect(parseWorkItemDisplayConfig(null)).toBeNull();
  });

  it('rejects invalid non-null writes', () => {
    const invalid = {
      ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
      version: 2,
    } as unknown as WorkItemDisplayConfig;

    expect(() => serializeWorkItemDisplayConfig(invalid)).toThrow(
      'Invalid work item display config',
    );
  });

  it('omits undefined updates and writes explicit null', () => {
    expect(serializeWorkItemDisplayConfigUpdate(undefined)).toEqual({});
    expect(serializeWorkItemDisplayConfigUpdate(null)).toEqual({
      workItemDisplayConfig: null,
    });
    expect(
      serializeWorkItemDisplayConfigUpdate(DEFAULT_WORK_ITEM_DISPLAY_CONFIG),
    ).toEqual({
      workItemDisplayConfig: JSON.stringify(DEFAULT_WORK_ITEM_DISPLAY_CONFIG),
    });
  });
});
