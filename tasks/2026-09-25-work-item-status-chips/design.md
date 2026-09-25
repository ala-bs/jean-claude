# Work-item status chips in the Feed List — Design
Date: 2026-09-25

## Problem

Feed task rows show linked work-item ID/type chips, but do not expose the
work-item state or board-column context that explains why a task is waiting.
Users need a compact, project-specific signal such as `Needs clarification`
when a linked Azure Boards item is blocked or sits in a configured column.

## Users & success criteria

Users who manage tasks from the Feed List should be able to:

- define project-specific rules matching Azure work-item fields;
- see an additional informational chip on a task when any linked work item
  matches a rule;
- understand which linked IDs caused the chip through a tooltip;
- keep the existing ID chips as the navigation target for opening work items.

Success means a configured rule appears reliably on task and subtask rows,
supports State, Board Column, and custom Azure fields, and never displays a
misleading chip when the linked item could not be fetched.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Linked work-item chips are rendered for task and subtask rows | `src/features/feed/ui-feed-list/feed-item-card.tsx` |
| Feed items carry linked IDs/types but not linked State or Board Column arrays | `shared/feed-types.ts` |
| Main-process enrichment already fetches linked work-item types | `electron/services/feed-service.ts` (`enrichTaskFeedItemsWithWorkItemTypes`) |
| Azure work-item payloads contain a typed field bag and support extra refNames | `src/lib/api.ts`, `electron/services/azure-devops-service.ts` |
| Project work-item display settings are persisted as JSON and edited in Project Settings | `shared/work-item-display-config-types.ts`, `electron/database/repositories/projects.ts`, `src/features/project/ui-project-settings/` |
| Core State and Board Column fields are already always fetched | `shared/work-item-field-types.ts` |

## Decisions

| # | Decision | Chosen | Why | Rejected alternatives |
| --- | --- | --- | --- | --- |
| 1 | Rule ownership | Per-project `workItemDisplayConfig.statusChips` | Azure workflows differ by project and the project JSON path already exists | Global rules; a new database table |
| 2 | Matching scope | Show a rule when any linked work item matches | A single blocked linked item is actionable and should not be hidden by other linked items | Require all linked items; one chip per matching work item |
| 3 | Supported fields | Any Azure field refName, including State and Board Column | Covers standard fields and project-specific custom workflows | State-only; Board Column-only |
| 4 | Matching semantics | Trimmed, case-insensitive exact string matching | Predictable and avoids accidental partial matches | Substring/regex matching |
| 5 | Chip interaction | Informational; tooltip lists matched work-item IDs | Keeps navigation behavior unambiguous and preserves current ID-chip click targets | Open an arbitrary matching item; feed filtering |
| 6 | Missing data | Hide the chip and log the enrichment reason | Avoids stale or misleading status signals | `Unknown` chip; cached stale chip |
| 7 | Rule presentation | User-configured label and tone; config order controls display order | Makes labels meaningful to each team and keeps rendering deterministic | Fixed labels/colors; automatic color inference |
| 8 | Persistence compatibility | Add optional property without a migration or version bump | Existing version-1 configs remain valid and can omit the feature | New migration/version 2 |

## In scope (v1)

- Extend the existing work-item display config with status-chip rules.
- Add Project Settings controls to add, edit, enable/disable, reorder, and
  remove rules.
- Fetch configured custom field refNames for linked task work items.
- Match linked items in the main process and expose aggregate matches to the
  renderer.
- Render matching chips for parent task and subtask Feed List rows.
- Add unit tests for validation/matching and component tests for rendering and
  tooltip contents.
- Log fetch failures, missing configured fields, and invalid rules with the
  existing feed debug logger.

## Out of scope

- Changing Azure work-item state or board columns from the Feed List.
- Automatic inference of a rule from a work-item value.
- Regex, ranges, boolean expressions, or cross-field rule conditions.
- Feed filtering, sorting, or partitioning by status chip.
- Persisting a historical/cache copy of linked work-item fields.
- Adding status chips to standalone work-item feed cards; this feature targets
  linked work-item chips on task rows.

## Constraints & dependencies

- Azure DevOps is the current work-item provider and supplies the field bag.
- Feed data crosses the main/preload/renderer boundary through shared types;
  no renderer-side provider call should be introduced.
- Existing `workItemDisplayConfig` validation must remain backward-compatible.
- The existing Feed List refresh/invalidation behavior is retained.
- The task feed may contain parent tasks and children, so enrichment must keep
  each item's `workItemIds` alignment intact.

## Approach chosen (and rejected)

### Chosen: main-process enrichment plus project-configured rules

Extend the existing project display config, resolve the configured field set in
the feed service, fetch each linked work item with those fields, evaluate rules
there, and send only matched chip metadata to the renderer. This fits the
existing provider boundary and prevents duplicate requests from every Feed List
row.

### Rejected: renderer-side status queries

The renderer could query each linked ID and match locally, but this would create
N+1 requests, complicate loading/error states, and bypass the existing main
process provider boundary.

### Rejected: fixed built-in status mapping

A fixed `Blocked` mapping would be quick, but it would not support project
specific board columns or custom fields—the central user need.

| Approach | Fits existing patterns | Effort | Risk | Reversible? |
| --- | --- | --- | --- | --- |
| Main-process enrichment + project config | High | Medium | Low | Yes |
| Renderer-side queries | Low | Medium | High (N+1/stale UI) | Yes |
| Fixed built-in mapping | Medium | Low | High (not adaptable) | Yes |

## Architecture

```text
Project Settings
      │ save existing project JSON
      ▼
ProjectRepository ──► workItemDisplayConfig.statusChips
                              │
                              ▼
Feed service ──► Azure getWorkItemById(extraFieldRefNames)
      │                    │
      │                    └─ fields: State, Board Column, custom fields
      ▼
FeedItem.workItemStatusChips
      │
      ▼
FeedItemCard ──► [#123] [Needs clarification]  Task title
```

Responsibilities:

- `shared/work-item-display-config-types.ts`: rule type, default shape, and
  validation.
- `src/features/project/ui-project-settings/`: rule editor UI and save payload.
- `electron/database/repositories/projects.ts`: existing JSON serialization;
  no schema migration.
- `electron/services/feed-service.ts`: resolve rules, fetch configured fields,
  evaluate linked items, and log failures.
- `shared/feed-types.ts`: shared aggregate match shape.
- `src/features/feed/ui-feed-list/feed-item-card.tsx`: present chips and
  accessible tooltips without provider logic.

## Data flow

### Happy path

1. A project has zero or more enabled `statusChips` rules in its existing
   display config.
2. The task feed loads projects and builds a project-ID-to-rule map.
3. For each linked task/subtask item, the feed service collects unique rule
   field refNames not already in the core field set.
4. The service fetches linked work items with core plus configured fields.
5. For each work item, it reads the configured field, stringifies supported
   scalar values, trims and lowercases them, and exact-matches against rule
   values.
6. It aggregates matches by rule. Each matched rule appears once and records
   the matching linked IDs.
7. The renderer displays the aggregate chips above the task title, alongside
   the existing ID/type chips.
8. Hover/focus tooltip text identifies the matched IDs, e.g. `#123, #456`.

### Failure paths

- No rules or no linked IDs: skip extra enrichment and emit no status chips.
- Invalid persisted config: existing parser treats it as absent; log the
  invalid config and render no status chips.
- Azure fetch failure for one item: retain existing ID/type data, omit status
  matches for that item, and log project/item/error context.
- Configured field is absent from the response: omit that rule for the item and
  log the missing refName at debug level.
- Azure rejects configured custom fields and retries without them: existing
  `partialFieldFailure` behavior is preserved; affected custom-field rules are
  omitted, while State/Board Column rules still work.
- A rule has no values, an invalid refName, or an empty label: validator rejects
  the config update; the settings UI prevents saving it.

## Data model / migrations

Extend `WorkItemDisplayConfig`:

```ts
type WorkItemStatusChipTone =
  | 'warning'
  | 'danger'
  | 'info'
  | 'success'
  | 'neutral';

type WorkItemStatusChipRule = {
  id: string;
  field: string;
  values: string[];
  label: string;
  tone: WorkItemStatusChipTone;
  enabled: boolean;
};

interface WorkItemDisplayConfig {
  version: 1;
  detail: WorkItemDetailLayout;
  board: { rows: WorkItemRowConfig[] };
  overridesByType: Record<string, WorkItemDetailLayout>;
  statusChips?: WorkItemStatusChipRule[];
}
```

The `id` is a stable client-generated rule identifier used for reordering and
React keys. `field` uses the existing Azure refName format validation and is
limited to the existing maximum refName length. `values` has at least one
non-empty value and a bounded list length consistent with existing config
limits. `label` is non-empty and bounded. No database migration is needed;
the JSON column accepts the optional property and old configs remain valid.

Extend `FeedItem`:

```ts
type WorkItemStatusChipMatch = {
  ruleId: string;
  label: string;
  tone: WorkItemStatusChipTone;
  workItemIds: string[];
};

workItemStatusChips?: WorkItemStatusChipMatch[];
```

The match array is omitted or empty when no rules match. IDs are strings to
match the existing linked-ID representation.

## Interfaces

Existing public project update interfaces continue to carry the expanded
`WorkItemDisplayConfig` through `UpdateProject.workItemDisplayConfig`.

New shared helpers should expose exact seams for parallel implementation:

```ts
function matchWorkItemStatusChipRules(params: {
  workItem: WorkItemFieldsHolder & { id: number };
  rules: WorkItemStatusChipRule[];
}): WorkItemStatusChipMatch[];

function getStatusChipRuleFieldRefNames(
  rules: WorkItemStatusChipRule[],
): string[];
```

The feed enrichment should use the existing provider call shape:

```ts
getWorkItemById({
  providerId,
  workItemId,
  extraFieldRefNames,
}): Promise<AzureDevOpsWorkItem | null>;
```

The settings editor should update the existing project payload:

```ts
updateProject.mutateAsync({
  projectId,
  data: { workItemDisplayConfig: nextConfig },
});
```

No new IPC route or preload method is required.

## Error handling

| Failure | Detect | Surface | Recover/log |
| --- | --- | --- | --- |
| Invalid config JSON/shape | Existing repository parser | No status chips; existing settings fallback | Existing repository warning; preserve existing behavior |
| Invalid rule in editor | Client validation before save | Inline validation and disabled save | User edits/removes rule |
| Work-item request failure | Provider promise rejection | Keep ID/type chip; hide status chip | `dbg.feed` with project, item, and error |
| Missing field | Field lookup returns `undefined` | Hide affected chip | `dbg.feed` with rule ID/refName/item |
| Partial custom-field response | Existing `partialFieldFailure` marker | Core-field rules still work; custom rules hidden | `dbg.feed` with omitted refNames |
| Multiple matches | Deterministic rule-order aggregation | All matched rule chips | Tooltip includes matched IDs |

## Security

- Rules and labels are local project configuration and are not sent to any
  external service except as field refNames in the existing Azure request.
- Custom refNames must pass the existing refName validation and URL encoding;
  no raw query text is constructed from user input.
- Chip labels are rendered as text, not HTML.
- Existing project/provider authorization remains the authority for work-item
  reads.

## Test strategy

Unit tests:

- accept old configs without `statusChips`;
- reject malformed rules, invalid refNames, empty labels/values, and invalid
  tones;
- extract only enabled custom refNames, excluding core duplicates;
- match State, Board Column, and custom fields case-insensitively and with
  trimming;
- aggregate one match per rule with all matching IDs in rule order;
- ignore missing fields and unsupported object values.

Service tests:

- pass configured custom fields to linked work-item fetches;
- enrich parent and child task items independently;
- retain existing type enrichment when status enrichment fails;
- omit custom-field chips after partial-field failure while keeping core-field
  chips;
- log failures with enough context to diagnose provider/enrichment problems.

Component tests:

- render status chips for a task and subtask;
- render tone classes and accessible label/tooltip text;
- render no status chip when the array is absent/empty;
- preserve existing ID-chip click behavior.

Manual verification:

1. Configure `System.State = Blocked` → `Needs clarification` in a project.
2. Link a blocked item to a task and refresh the Feed List.
3. Confirm the additional chip appears and its tooltip names the ID.
4. Change the item to a nonmatching state and confirm the chip disappears after
   the normal feed refresh.
5. Add a custom board-column rule and verify it works with a custom value.

## Rollout & rollback

The feature is backward-compatible and does not require a migration or flag.
Existing projects have no rules and therefore no visual change until configured.
Rollback is a code revert; persisted configs with the optional property are
ignored by older code because unknown JSON properties are not used.

## Open risks

- Azure board-column values can differ from displayed state values; settings
  should expose the raw field refName/value expectation clearly.
- A task with many linked IDs may require several provider calls; reuse the
  existing per-feed cache/chunking and dedupe identical provider/item requests.
- The settings UI could become dense; keep the editor to a compact repeatable
  row and defer rule templates/presets.
