export const WORK_ITEM_TITLE_PARSER_MAX_RULES = 10;
export const WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH = 500;
export const WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH = 100;
export const WORK_ITEM_TITLE_PARSER_MAX_TITLE_LENGTH = 2_000;
export const WORK_ITEM_TITLE_PARSER_MAX_MATCHES_PER_RULE = 100;

export interface WorkItemTitleParserRule {
  id: string;
  enabled: boolean;
  pattern: string;
  caseInsensitive: boolean;
}

export interface WorkItemTitleParserSetting {
  version: 1;
  enabled: boolean;
  rules: WorkItemTitleParserRule[];
}

export const STARTER_WORK_ITEM_TITLE_PARSER_SETTING: WorkItemTitleParserSetting = {
  version: 1,
  enabled: false,
  rules: [
    {
      id: 'bracket-label',
      enabled: false,
      pattern: String.raw`\[(?<label>[^\]]+)\]\s*`,
      caseInsensitive: false,
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasLabelCaptureGroup(pattern: string): boolean {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (!inCharacterClass && pattern.startsWith('(?<label>', index)) {
      return true;
    }
  }
  return false;
}

function isWorkItemTitleParserRule(
  value: unknown,
): value is WorkItemTitleParserRule {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH ||
    typeof value.enabled !== 'boolean' ||
    typeof value.pattern !== 'string' ||
    value.pattern.length > WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH ||
    typeof value.caseInsensitive !== 'boolean'
  ) {
    return false;
  }
  if (!value.enabled) return true;

  try {
    new RegExp(value.pattern, value.caseInsensitive ? 'gi' : 'g');
  } catch {
    return false;
  }
  return hasLabelCaptureGroup(value.pattern);
}

export function isWorkItemTitleParserSetting(
  value: unknown,
): value is WorkItemTitleParserSetting {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.rules) ||
    value.rules.length > WORK_ITEM_TITLE_PARSER_MAX_RULES
  ) {
    return false;
  }

  const ruleIds = new Set<string>();
  for (let index = 0; index < value.rules.length; index += 1) {
    const rule = value.rules[index];
    if (
      !(index in value.rules) ||
      !isWorkItemTitleParserRule(rule) ||
      ruleIds.has(rule.id)
    ) {
      return false;
    }
    ruleIds.add(rule.id);
  }
  return true;
}
