import {
  isWorkItemTitleParserSetting,
  WORK_ITEM_TITLE_PARSER_MAX_MATCHES_PER_RULE,
  WORK_ITEM_TITLE_PARSER_MAX_TITLE_LENGTH,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

export function parseWorkItemTitle({
  title,
  setting,
}: {
  title: string;
  setting: WorkItemTitleParserSetting | null;
}): { displayTitle: string; labels: string[]; matched: boolean } {
  const fallback = { displayTitle: title, labels: [], matched: false };
  if (
    title.length > WORK_ITEM_TITLE_PARSER_MAX_TITLE_LENGTH ||
    !setting ||
    !isWorkItemTitleParserSetting(setting) ||
    !setting.enabled
  ) {
    return fallback;
  }

  const enabledRules = setting.rules.filter((rule) => rule.enabled);
  if (enabledRules.length === 0) return fallback;

  let displayTitle = title;
  const labels: string[] = [];
  const normalizedLabels = new Set<string>();
  let matched = false;

  try {
    for (const rule of enabledRules) {
      const regex = new RegExp(rule.pattern, rule.caseInsensitive ? 'gi' : 'g');
      const chunks: string[] = [];
      let previousEnd = 0;
      let matchCount = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(displayTitle)) !== null) {
        matchCount += 1;
        if (
          matchCount > WORK_ITEM_TITLE_PARSER_MAX_MATCHES_PER_RULE ||
          match[0].length === 0
        ) {
          return fallback;
        }

        const label = match.groups?.label?.trim();
        if (!label) return fallback;

        chunks.push(displayTitle.slice(previousEnd, match.index));
        previousEnd = match.index + match[0].length;
        const normalizedLabel = label.toLowerCase();
        if (!normalizedLabels.has(normalizedLabel)) {
          normalizedLabels.add(normalizedLabel);
          labels.push(label);
        }
        matched = true;
      }

      if (matchCount > 0) {
        chunks.push(displayTitle.slice(previousEnd));
        displayTitle = chunks.join('');
      }
    }
  } catch {
    return fallback;
  }

  if (!matched) return fallback;
  const trimmedTitle = displayTitle.trim();
  return {
    displayTitle: trimmedTitle || 'Untitled',
    labels,
    matched: true,
  };
}
