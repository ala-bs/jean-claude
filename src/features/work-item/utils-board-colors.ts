// Board colorization: user-customizable tag colour rules + per-column colours.

export const BOARD_COLOR_PALETTE = [
  { key: 'rose', label: 'Rose', tone: 'var(--color-status-fail)' },
  { key: 'amber', label: 'Amber', tone: 'var(--color-status-run)' },
  { key: 'green', label: 'Green', tone: 'var(--color-status-done)' },
  { key: 'sky', label: 'Sky', tone: 'var(--color-status-azure)' },
  { key: 'cyan', label: 'Cyan', tone: 'var(--color-status-review)' },
  { key: 'indigo', label: 'Indigo', tone: 'var(--color-status-pr)' },
  { key: 'violet', label: 'Violet', tone: 'var(--color-acc)' },
  { key: 'grey', label: 'Grey — no signal', tone: 'var(--color-ink-3)' },
] as const;

export type BoardColorKey = (typeof BOARD_COLOR_PALETTE)[number]['key'];

export const BOARD_COLOR_TONES = Object.fromEntries(
  BOARD_COLOR_PALETTE.map((entry) => [entry.key, entry.tone]),
) as Record<BoardColorKey, string>;

export type BoardTagMatchType = 'exact' | 'prefix' | 'contains';
export const BOARD_TAG_MATCH_LABELS: Record<BoardTagMatchType, string> = {
  exact: 'is',
  prefix: 'starts with',
  contains: 'contains',
};

export type BoardTagRule = {
  id: string;
  type: BoardTagMatchType;
  match: string;
  color: BoardColorKey;
  label?: string;
};

export type BoardColumnApplyMode = 'rule' | 'tint' | 'both' | 'none';
export const BOARD_COLUMN_APPLY_LABELS: Record<BoardColumnApplyMode, string> = {
  rule: 'Top rule',
  tint: 'Lane tint',
  both: 'Both',
  none: 'Off',
};

export type BoardColorSettings = {
  rules: BoardTagRule[];
  /** Per-column colour overrides, keyed by normalized column name. */
  columnColors: Record<string, BoardColorKey>;
  /** Default apply mode for every column. */
  apply: BoardColumnApplyMode;
  /** Per-column apply overrides, keyed by normalized column name. */
  columnApply: Record<string, BoardColumnApplyMode>;
  /** Show the Azure DevOps priority (P1–P4) badge on board cards. */
  showPriority: boolean;
};

export const BOARD_PRIORITY_TONES: Partial<Record<number, string>> = {
  1: 'oklch(0.72 0.18 25)',
  2: 'oklch(0.78 0.15 70)',
  3: 'oklch(0.78 0.12 240)',
  4: 'var(--color-ink-2)',
};

export const DEFAULT_BOARD_COLOR_SETTINGS: BoardColorSettings = {
  rules: [
    { id: 'us-ready', type: 'exact', match: 'us ready', color: 'green', label: 'US ready' },
    { id: 'ready', type: 'exact', match: 'ready', color: 'green' },
    { id: 'change-request', type: 'exact', match: 'change request', color: 'amber' },
    { id: 'blocked', type: 'exact', match: 'blocked', color: 'rose' },
    { id: 'true-bug', type: 'exact', match: 'true-bug', color: 'rose', label: 'true bug' },
    { id: 'not-a-true-bug', type: 'exact', match: 'not-a-true-bug', color: 'grey' },
    { id: 'duplicate', type: 'exact', match: 'duplicate', color: 'grey' },
  ],
  columnColors: {},
  apply: 'both',
  columnApply: {},
  showPriority: false,
};

/** Persisted settings can be partial or hand-edited; never let them break the board. */
export function sanitizeBoardColorSettings(value: unknown): BoardColorSettings {
  const raw = (value ?? {}) as Partial<BoardColorSettings>;
  const colorKeys = new Set<string>(BOARD_COLOR_PALETTE.map((entry) => entry.key));
  const applyModes = new Set<string>(Object.keys(BOARD_COLUMN_APPLY_LABELS));
  const matchTypes = new Set<string>(Object.keys(BOARD_TAG_MATCH_LABELS));
  const records = <T extends string>(input: unknown, allowed: Set<string>) =>
    Object.fromEntries(
      Object.entries((input ?? {}) as Record<string, unknown>).filter(
        ([, entry]) => typeof entry === 'string' && allowed.has(entry),
      ),
    ) as Record<string, T>;
  return {
    rules: Array.isArray(raw.rules)
      ? raw.rules
          .filter(
            (rule): rule is BoardTagRule =>
              !!rule &&
              typeof rule.id === 'string' &&
              typeof rule.match === 'string' &&
              matchTypes.has(rule.type) &&
              colorKeys.has(rule.color),
          )
          .map((rule) => ({ ...rule }))
      : DEFAULT_BOARD_COLOR_SETTINGS.rules,
    columnColors: records<BoardColorKey>(raw.columnColors, colorKeys),
    apply: applyModes.has(raw.apply as string)
      ? (raw.apply as BoardColumnApplyMode)
      : DEFAULT_BOARD_COLOR_SETTINGS.apply,
    columnApply: records<BoardColumnApplyMode>(raw.columnApply, applyModes),
    showPriority:
      typeof raw.showPriority === 'boolean'
        ? raw.showPriority
        : DEFAULT_BOARD_COLOR_SETTINGS.showPriority,
  };
}

export function normalizeBoardColumnKey(columnName: string) {
  return columnName.trim().toLowerCase();
}

/** Built-in colour used when a column has no explicit override. */
export function getDefaultColumnColorKey(columnName: string): BoardColorKey {
  switch (normalizeBoardColumnKey(columnName)) {
    case 'active':
    case 'in progress':
    case 'in design':
      return 'amber';
    case 'blocked':
      return 'rose';
    case 'pr':
    case 'review':
    case 'code review':
      return 'indigo';
    case 'resolved':
    case 'done':
    case 'closed':
    case 'deployed':
      return 'green';
    case 'ready':
      return 'cyan';
    default:
      return 'grey';
  }
}

export function getBoardColumnColorKey(
  columnName: string,
  settings: BoardColorSettings,
): BoardColorKey {
  return (
    settings.columnColors[normalizeBoardColumnKey(columnName)] ??
    getDefaultColumnColorKey(columnName)
  );
}

export function getBoardColumnTone(
  columnName: string,
  settings: BoardColorSettings,
) {
  return BOARD_COLOR_TONES[getBoardColumnColorKey(columnName, settings)];
}

export function getBoardColumnApplyMode(
  columnName: string,
  settings: BoardColorSettings,
): BoardColumnApplyMode {
  return (
    settings.columnApply[normalizeBoardColumnKey(columnName)] ?? settings.apply
  );
}

/** First matching rule wins. */
export function matchBoardTagRule(tag: string, rules: BoardTagRule[]) {
  const value = tag.trim().toLowerCase();
  for (const rule of rules) {
    const match = rule.match.trim().toLowerCase();
    if (!match) continue;
    const hit =
      rule.type === 'exact'
        ? value === match
        : rule.type === 'prefix'
          ? value.startsWith(match)
          : value.includes(match);
    if (hit) return rule;
  }
  return null;
}

/**
 * Tone + label for a tag, or null when unmatched or matched by a "grey" rule
 * (recognised, but carries no signal — the card collapses it into "+n").
 */
export function getBoardTagTone(tag: string, rules: BoardTagRule[]) {
  const rule = matchBoardTagRule(tag, rules);
  if (!rule || rule.color === 'grey') return null;
  return { tone: BOARD_COLOR_TONES[rule.color], label: rule.label ?? tag };
}
