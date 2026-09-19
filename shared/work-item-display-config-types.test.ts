import { describe, expect, it } from 'vitest';

import {
  collectExtraFieldRefNames,
  DEFAULT_DETAIL_LAYOUT_FEED_MODAL,
  DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
  DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY,
  DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
  hashRefNames,
  isWorkItemDisplayConfig,
  resolveBoardRows,
  resolveDetailLayout,
  WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES,
  WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH,
  WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS,
  type WorkItemDisplayConfig,
  type WorkItemDisplaySurface,
  type WorkItemRowConfig,
} from './work-item-display-config-types';
import {
  FIELD_ASSIGNED_TO,
  FIELD_BOARD_COLUMN,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_STATE,
  FIELD_STORY_POINTS,
  FIELD_TAGS,
} from './work-item-field-types';

const ALL_SURFACES: WorkItemDisplaySurface[] = [
  'preview-editorial',
  'preview-readonly',
  'feed-modal',
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rows(...refNames: string[]): WorkItemRowConfig[] {
  return refNames.map((refName) => ({ refName, visible: true }));
}

function makeConfig(
  patch: Partial<WorkItemDisplayConfig> = {},
): WorkItemDisplayConfig {
  return { ...clone(DEFAULT_WORK_ITEM_DISPLAY_CONFIG), ...patch };
}

describe('isWorkItemDisplayConfig', () => {
  it('accepts the starter config', () => {
    expect(isWorkItemDisplayConfig(DEFAULT_WORK_ITEM_DISPLAY_CONFIG)).toBe(true);
    expect(isWorkItemDisplayConfig(clone(DEFAULT_WORK_ITEM_DISPLAY_CONFIG))).toBe(
      true,
    );
  });

  it('accepts a config with type overrides and custom refNames', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: { rows: rows('Custom.Severity'), tabs: [] },
          board: { rows: [] },
          overridesByType: {
            Bug: { rows: rows('Custom.Severity', 'Custom_2.Field'), tabs: [] },
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 1, 'x', true, []]) {
      expect(isWorkItemDisplayConfig(value), String(value)).toBe(false);
    }
  });

  it('rejects a wrong or missing version', () => {
    expect(isWorkItemDisplayConfig(makeConfig({ version: 2 as never }))).toBe(
      false,
    );
    expect(isWorkItemDisplayConfig(makeConfig({ version: '1' as never }))).toBe(
      false,
    );
    const noVersion = clone(
      DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
    ) as unknown as Record<string, unknown>;
    delete noVersion.version;
    expect(isWorkItemDisplayConfig(noVersion)).toBe(false);
  });

  it('rejects non-array rows in detail, board and overrides', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ detail: { rows: {} as never, tabs: [] } }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(makeConfig({ board: { rows: null as never } })),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          overridesByType: { Bug: { rows: 'nope' as never, tabs: [] } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects a row that is not a {refName, visible} pair', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: { rows: [{ refName: FIELD_STATE } as never], tabs: [] },
        }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: {
            rows: [{ refName: FIELD_STATE, visible: 'yes' } as never],
            tabs: [],
          },
        }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ detail: { rows: [null as never], tabs: [] } }),
      ),
    ).toBe(false);
  });

  it('rejects a refName over the length cap but accepts one at the cap', () => {
    const atCap = 'a'.repeat(WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH);
    const overCap = 'a'.repeat(WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH + 1);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ detail: { rows: rows(atCap), tabs: [] } }),
      ),
    ).toBe(true);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ detail: { rows: rows(overCap), tabs: [] } }),
      ),
    ).toBe(false);
  });

  it('rejects a refName failing the charset regex', () => {
    for (const bad of [
      '',
      'Custom Severity',
      'Custom-Severity',
      'Custom.Severity;drop',
      'Custom.Sévérité',
      'Custom.Severity\n',
    ]) {
      expect(
        isWorkItemDisplayConfig(
          makeConfig({ detail: { rows: rows(bad), tabs: [] } }),
        ),
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('rejects over-cap rows but accepts exactly the cap', () => {
    const atCap = rows(
      ...Array.from(
        { length: WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS },
        (_unused, index) => `Custom.F${index}`,
      ),
    );
    expect(
      isWorkItemDisplayConfig(makeConfig({ detail: { rows: atCap, tabs: [] } })),
    ).toBe(true);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: {
            rows: [...atCap, { refName: 'Custom.Overflow', visible: true }],
            tabs: [],
          },
        }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          board: {
            rows: [...atCap, { refName: 'Custom.Overflow', visible: true }],
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects over-cap overrides but accepts exactly the cap', () => {
    const buildOverrides = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [
          `Type${index}`,
          { rows: rows('Custom.Severity'), tabs: [] },
        ]),
      );
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          overridesByType: buildOverrides(
            WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES,
          ),
        }),
      ),
    ).toBe(true);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          overridesByType: buildOverrides(
            WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES + 1,
          ),
        }),
      ),
    ).toBe(false);
  });

  it('rejects an empty override key and a non-object overridesByType', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ overridesByType: { '': { rows: [], tabs: [] } } }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(makeConfig({ overridesByType: [] as never })),
    ).toBe(false);
  });

  it('rejects an unknown tabs[].id', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: {
            rows: [],
            tabs: [{ id: 'attachments' as never, visible: true }],
          },
        }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          overridesByType: {
            Bug: { rows: [], tabs: [{ id: 'links' as never, visible: true }] },
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects malformed tabs entries and a non-array tabs', () => {
    expect(
      isWorkItemDisplayConfig(
        makeConfig({ detail: { rows: [], tabs: {} as never } }),
      ),
    ).toBe(false);
    expect(
      isWorkItemDisplayConfig(
        makeConfig({
          detail: { rows: [], tabs: [{ id: 'comments' } as never] },
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveDetailLayout', () => {
  const config = makeConfig({
    detail: { rows: rows(FIELD_STATE), tabs: [] },
    overridesByType: { Bug: { rows: rows('Custom.Severity'), tabs: [] } },
  });

  it('returns the override on a hit', () => {
    expect(resolveDetailLayout(config, 'Bug', 'preview-editorial')).toBe(
      config.overridesByType.Bug,
    );
  });

  it('returns the override on a hit for every surface', () => {
    for (const surface of ALL_SURFACES) {
      expect(resolveDetailLayout(config, 'Bug', surface)).toBe(
        config.overridesByType.Bug,
      );
    }
  });

  it('inherits detail on an override miss', () => {
    expect(resolveDetailLayout(config, 'User Story', 'preview-editorial')).toBe(
      config.detail,
    );
    expect(resolveDetailLayout(config, '', 'preview-editorial')).toBe(
      config.detail,
    );
  });

  it('resolves the same layout for every surface once a config exists', () => {
    for (const surface of ALL_SURFACES) {
      expect(resolveDetailLayout(config, 'User Story', surface)).toBe(
        config.detail,
      );
    }
  });

  it('returns the per-surface default for a null config', () => {
    expect(resolveDetailLayout(null, 'Bug', 'preview-editorial')).toBe(
      DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
    );
    expect(resolveDetailLayout(null, 'Bug', 'preview-readonly')).toBe(
      DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY,
    );
    expect(resolveDetailLayout(null, 'Bug', 'feed-modal')).toBe(
      DEFAULT_DETAIL_LAYOUT_FEED_MODAL,
    );
  });

  // KNOWN MISMATCH (T4 → T0): `config.overridesByType[workItemType] ?? detail`
  // walks the prototype chain, so a work item type literally named `toString`
  // or `constructor` resolves to an inherited Object.prototype member instead
  // of falling back to `detail`. Fix in work-item-display-config-types.ts with
  // `Object.hasOwn(config.overridesByType, workItemType)` (or a null-prototype
  // record), then flip this to a plain `it`.
  it('does not treat Object.prototype keys as overrides', () => {
    expect(resolveDetailLayout(config, 'toString', 'preview-editorial')).toBe(
      config.detail,
    );
    expect(
      resolveDetailLayout(config, 'constructor', 'preview-editorial'),
    ).toBe(config.detail);
    for (const surface of ALL_SURFACES) {
      expect(resolveDetailLayout(config, 'toString', surface)).toBe(
        config.detail,
      );
    }
  });
});

describe('per-surface default detail layouts', () => {
  const visibleRefNames = (layout: { rows: WorkItemRowConfig[] }): string[] =>
    layout.rows.filter((row) => row.visible).map((row) => row.refName);

  it('preview-editorial matches the editorial metadata region', () => {
    expect(visibleRefNames(DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL)).toEqual([
      FIELD_ASSIGNED_TO,
      FIELD_STATE,
      FIELD_BOARD_COLUMN,
      FIELD_ITERATION_PATH,
      FIELD_STORY_POINTS,
      FIELD_PRIORITY,
      FIELD_TAGS,
    ]);
  });

  it('preview-readonly matches the non-editorial metadata region', () => {
    expect(visibleRefNames(DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY)).toEqual([
      FIELD_ASSIGNED_TO,
      FIELD_STATE,
      FIELD_PRIORITY,
      FIELD_TAGS,
    ]);
  });

  it('feed-modal matches the feed details metadata region (no priority)', () => {
    expect(visibleRefNames(DEFAULT_DETAIL_LAYOUT_FEED_MODAL)).toEqual([
      FIELD_STATE,
      FIELD_BOARD_COLUMN,
      FIELD_ASSIGNED_TO,
      FIELD_STORY_POINTS,
      FIELD_ITERATION_PATH,
      FIELD_TAGS,
    ]);
    expect(visibleRefNames(DEFAULT_DETAIL_LAYOUT_FEED_MODAL)).not.toContain(
      FIELD_PRIORITY,
    );
  });

  it('are all valid layouts and the starter config uses the editorial one', () => {
    for (const layout of [
      DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
      DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY,
      DEFAULT_DETAIL_LAYOUT_FEED_MODAL,
    ]) {
      expect(
        isWorkItemDisplayConfig({
          ...DEFAULT_WORK_ITEM_DISPLAY_CONFIG,
          detail: layout,
        }),
      ).toBe(true);
    }
    expect(DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail).toBe(
      DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL,
    );
  });
});

describe('resolveBoardRows', () => {
  it('returns the configured board rows, or the default for null', () => {
    const config = makeConfig({ board: { rows: rows('Custom.Severity') } });
    expect(resolveBoardRows(config)).toBe(config.board.rows);
    expect(resolveBoardRows(null)).toBe(
      DEFAULT_WORK_ITEM_DISPLAY_CONFIG.board.rows,
    );
  });
});

describe('collectExtraFieldRefNames', () => {
  it('returns an empty array for a null config and for the default config', () => {
    expect(collectExtraFieldRefNames(null)).toEqual([]);
    expect(collectExtraFieldRefNames(DEFAULT_WORK_ITEM_DISPLAY_CONFIG)).toEqual(
      [],
    );
  });

  it('excludes core refNames even when visible', () => {
    const config = makeConfig({
      detail: {
        rows: rows(FIELD_STATE, FIELD_ASSIGNED_TO, 'Custom.Severity'),
        tabs: [],
      },
      board: { rows: rows(FIELD_PRIORITY, FIELD_TAGS) },
      overridesByType: {},
    });
    expect(collectExtraFieldRefNames(config)).toEqual(['Custom.Severity']);
  });

  it('dedupes across detail, board and every override', () => {
    const config = makeConfig({
      detail: { rows: rows('Custom.A', 'Custom.B'), tabs: [] },
      board: { rows: rows('Custom.B', 'Custom.C') },
      overridesByType: {
        Bug: { rows: rows('Custom.A', 'Custom.D'), tabs: [] },
        Task: { rows: rows('Custom.D', 'Custom.E'), tabs: [] },
      },
    });
    const extras = collectExtraFieldRefNames(config);
    expect(extras).toEqual([
      'Custom.A',
      'Custom.B',
      'Custom.C',
      'Custom.D',
      'Custom.E',
    ]);
    expect(new Set(extras).size).toBe(extras.length);
  });

  it('excludes a refName hidden everywhere', () => {
    const config = makeConfig({
      detail: { rows: [{ refName: 'Custom.Hidden', visible: false }], tabs: [] },
      board: { rows: [{ refName: 'Custom.Hidden', visible: false }] },
      overridesByType: {
        Bug: { rows: [{ refName: 'Custom.Hidden', visible: false }], tabs: [] },
      },
    });
    expect(collectExtraFieldRefNames(config)).toEqual([]);
  });

  it('includes a hidden refName when it is visible somewhere else', () => {
    const visibleInBoard = makeConfig({
      detail: { rows: [{ refName: 'Custom.Mixed', visible: false }], tabs: [] },
      board: { rows: [{ refName: 'Custom.Mixed', visible: true }] },
      overridesByType: {},
    });
    expect(collectExtraFieldRefNames(visibleInBoard)).toEqual(['Custom.Mixed']);

    const visibleInOverride = makeConfig({
      detail: { rows: [{ refName: 'Custom.Mixed', visible: false }], tabs: [] },
      board: { rows: [] },
      overridesByType: {
        Bug: { rows: [{ refName: 'Custom.Mixed', visible: true }], tabs: [] },
      },
    });
    expect(collectExtraFieldRefNames(visibleInOverride)).toEqual([
      'Custom.Mixed',
    ]);
  });
});

describe('hashRefNames', () => {
  it('returns a sentinel for an empty list', () => {
    expect(hashRefNames([])).toBe('none');
  });

  it('is order-independent', () => {
    expect(hashRefNames(['Custom.A', 'Custom.B'])).toBe(
      hashRefNames(['Custom.B', 'Custom.A']),
    );
    expect(hashRefNames(['a', 'b', 'c'])).toBe(hashRefNames(['c', 'a', 'b']));
  });

  it('is duplicate-insensitive', () => {
    expect(hashRefNames(['Custom.A', 'Custom.A', 'Custom.B'])).toBe(
      hashRefNames(['Custom.A', 'Custom.B']),
    );
  });

  it('is stable across calls and pinned to a known value', () => {
    expect(hashRefNames(['Custom.A'])).toBe(hashRefNames(['Custom.A']));
    expect(hashRefNames(['Custom.A'])).toBe('163a2d73');
    expect(hashRefNames(['Custom.A', 'Custom.B'])).toBe('6f21428e');
  });

  it('distinguishes different sets', () => {
    const seen = new Set([
      hashRefNames(['Custom.A']),
      hashRefNames(['Custom.B']),
      hashRefNames(['Custom.A', 'Custom.B']),
      hashRefNames(['Custom.AB']),
    ]);
    expect(seen.size).toBe(4);
  });

  it('returns an 8-character lowercase hex digest', () => {
    expect(hashRefNames(['Custom.A'])).toMatch(/^[0-9a-f]{8}$/);
    expect(hashRefNames(['x'])).toMatch(/^[0-9a-f]{8}$/);
  });
});
