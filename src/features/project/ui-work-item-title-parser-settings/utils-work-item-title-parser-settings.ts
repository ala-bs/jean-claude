import {
  WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH,
  WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH,
  WORK_ITEM_TITLE_PARSER_MAX_RULES,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

function containsLabelCapture(pattern: string) {
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

export function validateWorkItemTitleParserDraft(
  setting: WorkItemTitleParserSetting,
) {
  const ruleErrors = new Map<number, string>();
  const seenIds = new Set<string>();

  if (setting.rules.length > WORK_ITEM_TITLE_PARSER_MAX_RULES) {
    return {
      isValid: false,
      ruleErrors,
      settingError: `Use no more than ${WORK_ITEM_TITLE_PARSER_MAX_RULES} rules.`,
    };
  }

  for (const [index, rule] of setting.rules.entries()) {
    let error: string | undefined;
    if (
      !rule.id ||
      rule.id.length > WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH
    ) {
      error = `Rule ID must be 1-${WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH} characters.`;
    } else if (seenIds.has(rule.id)) {
      error = 'Rule IDs must be unique.';
    } else if (rule.pattern.length > WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH) {
      error = `Pattern must be ${WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH} characters or fewer.`;
    } else if (rule.enabled) {
      try {
        new RegExp(rule.pattern, rule.caseInsensitive ? 'gi' : 'g');
      } catch {
        error = 'Pattern is not a valid regular expression.';
      }
      if (!error && !containsLabelCapture(rule.pattern)) {
        error = 'Pattern must include a named capture group: (?<label>...).';
      }
    }

    seenIds.add(rule.id);
    if (error) ruleErrors.set(index, error);
  }

  return {
    isValid: ruleErrors.size === 0,
    ruleErrors,
    settingError: null,
  };
}
