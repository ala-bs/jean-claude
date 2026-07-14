# Azure Work Item Title Parser Design

## Goal

Allow each Jean-Claude project to clean Azure work item titles in Azure Board overlay and display extracted title segments as labels without changing raw Azure data.

## Data Flow

```text
Project.workItemTitleParser (nullable JSON)
                    |
                    v
Azure fields.title -> parseWorkItemTitle -> { displayTitle, labels, matched }
                                           |
                                           v
                                  overlay title presenter
```

Raw `fields.title` remains source of truth for Azure search, inline title editing, updates, prompts, and all non-overlay views.

## Configuration

Project stores versioned configuration:

```ts
type WorkItemTitleParserSetting = {
  version: 1;
  enabled: boolean;
  rules: Array<{
    id: string;
    enabled: boolean;
    pattern: string;
    caseInsensitive: boolean;
  }>;
};
```

Each enabled rule:

- Compiles as global JavaScript regex, optionally case-insensitive.
- Requires named capture group `label`.
- Runs against output left by previous rule.
- Extracts and trims `label` from every match.
- Removes each complete match from display title.

Labels deduplicate case-insensitively while preserving first spelling. Display title trims outer whitespace but preserves internal whitespace. No match returns raw title and no labels. A matched title reduced to empty displays `Untitled`.

Bounds: 10 rules, 500 pattern characters, 2,000 title characters, 100 matches per rule. Invalid configuration cannot save. Runtime parsing anomalies return raw title rather than partially hiding content.

## UI

Project Settings > Integrations > Work Items gains title parser editor when Azure work items are linked.

- Disabled starter rule: `\[(?<label>[^\]]+)\]\s*`
- Enable toggle
- Add, remove, enable, and reorder rules
- Pattern input and ignore-case toggle
- Live raw-title preview with clean title and parsed labels
- Inline validation; last valid persisted setting stays active

Azure Board overlay uses parsed titles in board cards, main preview, related work item rows, and related bugs panel. Extracted labels use a dedicated row separate from Azure tags. Compact rows show first five labels and a keyboard-accessible `+N` tooltip listing all. Main preview shows all labels. Title editor always shows raw Azure title.

## Scope

Included:

- Per-project database persistence
- Azure Board overlay display only
- Raw search and editing behavior
- Parser, persistence, and presenter tests

Excluded:

- Filtering/grouping by extracted labels
- Task prompt or generated task name changes
- Full work item route, PR, feed, and activity display changes
- Custom JavaScript execution

## Decisions

- Pure parser plus presenter avoids derived cache state and stale results.
- Ordered regex rules provide flexible conventions without arbitrary code execution.
- Native regex with bounds keeps implementation small; configuration remains trusted local project data.
- Raw fallback prevents accidental information loss.
