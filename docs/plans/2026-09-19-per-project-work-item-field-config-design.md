# Per-project work item display configuration — Design

Date: 2026-09-19

## Problem

Azure Boards work item details are rendered from a field list hardcoded in two
places. `electron/services/azure-devops-service.ts` fetches the **full** field
payload from Azure and then hand-maps it into a fixed 17-key
`AzureDevOpsWorkItem.fields` object, discarding everything else — so a team's
custom fields (`Custom.Severity`, `Custom.RootCause`, …) can never be shown. The
two detail surfaces, `src/features/work-item/ui-work-item-preview/` (1403 lines)
and `src/features/feed/ui-work-item-details/` (1579 lines), then each hardcode
their own near-identical-but-not-identical row set.

Different projects track different things. A project should be able to choose
which fields appear in work item details, in what order, which content tabs
show, and what board cards display — including fields Jean-Claude has never
heard of.

## Users & success criteria

**User:** a developer who owns a Jean-Claude project wired to an Azure Boards
project whose process template has custom fields, or whose team simply doesn't
care about half the default rows.

Success:

1. In Project Settings → Integrations, the user picks fields from their own
   Azure process template (not a Jean-Claude-curated list) and reorders them.
2. The preview panel, the feed modal, and board cards honour the choice.
3. A Bug can show a different row set than a User Story.
4. Projects that never touch the setting see **byte-identical** behaviour to
   today.

## Codebase findings

| Finding | Evidence (path) |
| --- | --- |
| Work items are fetched with no `fields=` param; full payload returned then hand-mapped at 3 sites | `electron/services/azure-devops-service.ts` `queryWorkItems` (724), `getWorkItemById` (1010), `getWorkItemsByIds` (1084); mapping ~984, ~1058, ~1159 |
| The 17-key typed field shape lives in the service file, not `shared/` | `electron/services/azure-devops-service.ts:99-127` `AzureDevOpsWorkItem` |
| `workItem.fields.*` is read at **257 call sites across 23 files**, incl. main-process services | grep; see blast-radius table below |
| Inline edit is already refName-keyed, so it generalizes | `updateWorkItemField({providerId, workItemId, field, value})`, service:4307 |
| Per-project JSON-text column is an established pattern (5 existing columns), parsed defensively with a type guard + fallback | `electron/database/schema.ts` `ProjectTable:111-155`; `electron/database/repositories/projects.ts` `rowToProject`, `parseWorkItemTitleParser` |
| Closest analogue end-to-end: the work item title parser | `shared/work-item-title-parser-types.ts`, migration `075_project_work_item_title_parser.ts`, `src/features/project/ui-work-item-title-parser-settings/` |
| Next free migration number is **091** | `electron/database/migrations/090_project_auto_accept_on_task_creation.ts` |
| Settings dirty-tracking is per-`UpdateProject`-key with a versioned save queue | `src/features/project/ui-project-settings/utils-project-settings-save-data.ts` |
| Provider-scoped reference data (states, iterations, board columns) is already cached in React Query, not SQLite | `src/hooks/use-work-items.ts` `useWorkItemStates`, `useIterations`, `useBoardColumns` |
| Some IPC handlers already receive `projectId`, so passing project context is precedented | `azureDevOps:getWorkItemSummary` / `generateWorkItemSummary`, `electron/ipc/handlers.ts` |

### Blast radius of the field-shape change

23 files, 257 sites. Per-field counts: title 35, workItemType 35, state 32,
assignedTo 23, description 19, iterationPath 17, tags 13, reproSteps 10,
acceptanceCriteria 9, priority 6, changedDate 5, boardColumn 5, stackRank 4,
storyPoints 4, teamProject 4, assignedToUniqueName 3, boardColumnDone 3.

Non-UI consumers that need fields regardless of what a project chooses to
*display* — the reason fetch is decoupled from visibility:

- `electron/services/feed-service.ts`
- `electron/services/work-item-summary-source.ts` (+ test)
- `electron/services/work-item-verification-note-service.ts`
- `src/features/work-item/ui-work-item-board/utils.ts` (sorts by stack rank)
- `src/features/work-item/ui-work-item-workspace/build-board-model.ts` (filters
  on type/tags/state/assignee)
- `src/features/new-task/ui-new-task-overlay/`, `ui-prompt-composer/`,
  `src/routes/projects/$projectId/tasks/new.tsx` (build task prompts from
  title/description/acceptance criteria)

## Decisions

| # | Decision | Chosen | Why | Rejected alternatives |
| --- | --- | --- | --- | --- |
| 1 | Which fields are configurable | Any Azure field refName, incl. custom | Curated-17 can't express the actual need | Show/hide of the known 17 only; known-now-custom-later |
| 2 | What the config controls | Visibility + order + which content tabs | Covers the ask without per-field label/editability config | Custom labels; per-field editability toggle |
| 3 | Surfaces | Preview panel + feed modal (**unified** into one renderer) + board cards (**separately** configured) | Preview and modal duplicate each other today; cards are a different layout problem | List rows (left as-is) |
| 4 | Settings location | Project Settings → Integrations | Sits with the existing Work Items link + title parser | New dedicated section; inline gear popover in the panel |
| 5 | Default for unconfigured projects | Column NULL ⇒ fall back to today's hardcoded layout | Zero backfill, zero migration risk, existing behaviour preserved | Backfill an explicit default into every project row |
| 6 | Payload shape | Full migration: `fields` becomes `Record<refName, WorkItemFieldValue>` across all 23 files | One field model everywhere; the renderer is refName-driven regardless | Hybrid typed-17 + `rawFields` bag (rejected: permanently forks known vs custom access) |
| 7 | Does hiding a field stop fetching it? | **No.** Fetch set = `CORE_FIELD_REFNAMES ∪ configured extras` | Display config must not control data availability — see blast-radius list | Fetch exactly what is configured (rejected: silently degrades board sort, summaries, task prompts) |
| 8 | Cache coherence on config change | Hash of configured extra refNames goes into the React Query key | Automatic, precise, old entries GC naturally | Explicit `invalidateQueries` on save |
| 9 | Field picker data source | `GET /{project}/_apis/wit/workitemtypes/{type}/fields` per type, merged | Only fields valid for this project's types; also yields per-type validity needed by decision 10 | Org-wide `/wit/fields`; derive from sampled work items (misses empty fields) |
| 10 | Per-work-item-type layouts | One Default layout + explicit opt-in `Add override for type…`; types without an override inherit | Keeps the common case a single list | A pre-populated tab per work item type |
| 11 | Rendering an unknown field | Render by the field's Azure-declared `type` from cached metadata | Correct-looking out of the box | User picks a display type; always plain text |
| 12 | Editing custom fields | Read-only in v1; the 7 currently-editable fields stay editable | Avoids picklists / allowed-values / validation entirely | Editable for simple scalars |
| 13 | Board card config | Same refName engine, separate saved list, **no cap** on field count | User's call if a card overflows | Soft cap ~5 with a warning |
| 14 | Accessing values at the 257 sites | Exported refName constants + typed accessors (`getTitle`, `getAssignee`, `getStringField`…) | Call sites stay readable and typed; codemod is mechanical | Raw `item.fields['System.Title'] as string` indexing |
| 15 | Persistence | One JSON-text column `workItemDisplayConfig` = `{version, detail, board, overridesByType}` | Single migration, single type guard, atomic save | Two columns (detail + board) |
| 16 | Rows vs tabs in the config | Two separate ordered lists, `rows[]` and `tabs[]` | They render in different regions of the panel; not interchangeable | One flat list with a per-entry render mode |
| 17 | Configured refName no longer exists | Skip silently in the panel; mark **unavailable** in the settings UI | Detail view never shows broken rows; user is told where it's fixable | Em-dash placeholder row; inline warning in the panel |
| 18 | Per-type overrides on board cards | Detail panel only; one board config for all types | Cards are uniform by nature; halves the override UI | Overrides on both |
| 19 | Field-metadata cache | React Query per `(providerId, azureProjectId)`, `staleTime` 1h, on demand | Matches how states/iterations/board columns are already cached; no new table | Persist a snapshot in SQLite |
| 20 | `assignedTo` shape | `System.AssignedTo` collapses the two string fields into one identity object | Azure's native shape; avoids a parallel `…UniqueName` key | Keep two flat string keys |
| 21 | `tags` shape | Accessor returns `string[]`; raw value stays the Azure `"a; b"` string | Several call sites split it by hand today | Keep raw string everywhere |

## In scope (v1)

- New column `projects.workItemDisplayConfig` (migration 091), nullable.
- `AzureDevOpsWorkItem.fields` → `Record<AzureFieldRefName, WorkItemFieldValue>`,
  with typed accessors, migrated across all 23 files.
- `extraFieldRefNames` threaded through `queryWorkItems`, `getWorkItemById`,
  `getWorkItemsByIds` (IPC + service + hooks).
- New IPC `azureDevOps.getWorkItemTypeFields` + `useWorkItemTypeFields` hook.
- New shared renderer `src/features/work-item/ui-work-item-field-rows/`,
  consumed by `ui-work-item-preview`, `feed/ui-work-item-details`, and
  `ui-work-item-board/card-board-item.tsx`.
- New settings pane `src/features/project/ui-work-item-display-settings/` in the
  Integrations section: field picker, drag-reorder, tab toggles, per-type
  override management.

## Out of scope

- Editing custom fields inline (picklists, allowed values, validation).
- Per-field custom labels and per-field editability toggles.
- Configuring work item **list** rows (`ui-work-item-list`).
- Per-type overrides for board cards.
- Sharing / exporting a config between projects; org-level defaults.
- Configuring PR-side or non-Azure providers.

## Constraints & dependencies

- Azure DevOps REST `api-version=7.0` (matches every existing call).
- PAT auth via `getProviderAuth` → `TokenRepository.getDecryptedToken`; org name
  derived from the last segment of `provider.baseUrl`. Unchanged.
- SQLite/Kysely; migration must be additive (`addColumn`), no table recreation.
- TypeScript strict; kebab-case files; one component per folder, no barrels.
- React 19 Zustand selector rules (no new array/object identities per call).

## Approach chosen (and rejected)

**Chosen — A: refName map + config-driven renderer.** Normalize work items to
Azure's own field model, drive all three surfaces from one saved per-project
config, and resolve display semantics from cached Azure field metadata.

| Approach | Fits existing patterns | Effort | Risk | Reversible |
| --- | --- | --- | --- | --- |
| **A. refName map + config-driven renderer** | Yes — mirrors `workItemTitleParser` | High | Medium (257 mechanical call sites) | Yes |
| B. Hybrid typed-17 + `rawFields` bag | Yes | Medium | Low | Yes, but forks the model permanently |
| C. Renderer-only, no fetch/shape change | Partly | Low | Low | Cannot ever show custom fields |

B was rejected because every future field lives in a second-class bag and every
consumer must know which of two places to look. C cannot satisfy decision 1.

## Architecture

```
 SETTINGS (write path)
 ProjectSettings → Integrations
   └─ <WorkItemDisplaySettings>            src/features/project/ui-work-item-display-settings/
        ├─ field picker  ◄── useWorkItemTypeFields(providerId, azureProjectId)
        │                      └─ IPC azureDevOps:getWorkItemTypeFields
        │                           └─ GET /{project}/_apis/wit/workitemtypes/{type}/fields
        │                              (per type, merged, React Query staleTime 1h)
        ├─ rows[] / tabs[] drag-reorder + visibility toggles
        └─ "Add override for type…" → overridesByType
              │ markFieldDirty('workItemDisplayConfig') → project settings save queue
              ▼
      projects.workItemDisplayConfig   TEXT/JSON · migration 091 · NULL ⇒ today's layout

 READ path
 useWorkItems(providerId, …)                 extras = collectExtraFieldRefNames(project.workItemDisplayConfig)
   queryKey ['work-items', providerId, …, hashRefNames(extras)]   ◄── config change ⇒ refetch
        │
        ▼ IPC azureDevOps:queryWorkItems({ …, extraFieldRefNames })
   AzureDevOpsService
        fetchSet = CORE_FIELD_REFNAMES ∪ extras     ← display config NEVER gates the fetch set
        └─ WIQL → ids → GET /_apis/wit/workitems?ids=…&fields=…&$expand=relations
        ▼
   AzureDevOpsWorkItem.fields : Record<AzureFieldRefName, WorkItemFieldValue>
        │
        ├──► 21 existing consumers ── typed accessors (getTitle/getState/getAssignee/…)
        │
        └──► <WorkItemFieldRows layout metadata item />
                 ├─ ui-work-item-preview        ┐ same renderer ⇒ unified layout
                 ├─ feed/ui-work-item-details   ┘
                 └─ ui-work-item-board/card-board-item   (config.board, no per-type override)
                       renders by metadata.type:
                       string│plainText → text      html      → sanitized rich text
                       integer│double   → number    dateTime  → relative date
                       boolean          → check     identity  → avatar + name
                       treePath         → last segment, full path on hover
                       picklistString   → chip
```

Component responsibilities, one line each:

- `shared/work-item-field-types.ts` — the refName value model, `CORE_FIELD_REFNAMES`, typed accessors. No React, no IPC.
- `shared/work-item-display-config-types.ts` — the saved config shape, its type guard, layout resolution, extras collection, query-key hash.
- `AzureDevOpsService.getWorkItemTypeFields` — fetch + merge + normalize Azure field metadata for a project's work item types.
- `ui-work-item-field-rows` — given a resolved layout + metadata map + work item, render metadata rows; knows nothing about where the config came from.
- `ui-work-item-display-settings` — edit and validate the config; the only place that surfaces "unavailable field".

## Data flow

### Happy path — opening a Bug in the preview panel

1. `ui-work-item-preview` mounts with `projectId`, `providerId`, `workItemId`.
2. `useProject(projectId)` yields `workItemDisplayConfig` (possibly `null`).
3. `collectExtraFieldRefNames(config)` → e.g. `['Custom.Severity']`; `hashRefNames` → `'a91f'`.
4. `useWorkItemById({providerId, workItemId, extraFieldRefNames})`, query key ends in `'a91f'`.
5. Main process: `fetchSet = CORE_FIELD_REFNAMES ∪ ['Custom.Severity']`; `GET /_apis/wit/workitems/{id}?fields=…&$expand=relations`.
6. Response mapped to `fields: Record<refName, WorkItemFieldValue>`; identity objects normalized to `WorkItemIdentity`.
7. `useWorkItemTypeFields({providerId, azureProjectId})` returns the metadata map (cache hit after first use, 1h stale time).
8. `resolveDetailLayout(config, getWorkItemType(item))` → the `'Bug'` override if present, else `config.detail`, else `DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail`.
9. `ui-work-item-field-rows` renders `layout.rows` in order, skipping `visible: false` and refNames absent from the metadata map (decision 17).
10. `layout.tabs` filters which content tabs mount; `reproSteps` keeps its existing type-is-Bug guard on top of the config.

### Failure paths

| # | Failure | Detect | Surface | Recover | Log |
| --- | --- | --- | --- | --- | --- |
| F1 | `workItemDisplayConfig` JSON is corrupt / fails the type guard | `isWorkItemDisplayConfig` false in `rowToProject` | Nothing user-facing; panel shows the default layout | Treat as `null` | `console.warn` in the repository, matching `parseWorkItemTitleParser` |
| F2 | Configured refName not in metadata (removed from template) | refName missing from the metadata map | Row skipped in the panel; settings UI marks it **Unavailable** with a remove action | Keep it in the saved config — a template change may restore it | none |
| F3 | Azure rejects an extra refName on `fields=` (400) | Non-2xx from the work items call | Work items fail to load | Retry once with `fetchSet = CORE_FIELD_REFNAMES` only, and surface a one-line "some configured fields could not be loaded" notice | `console.error` with the offending refNames |
| F4 | `getWorkItemTypeFields` fails (network / 401 / PAT expired) | Thrown in the IPC handler | Field picker shows the existing provider-auth error state; **detail panels still render** with a metadata-less fallback (core fields use built-in metadata, extras render as text) | React Query retry + manual refresh | `console.error` |
| F5 | A field's value type disagrees with declared metadata | Renderer type guard fails | Falls back to `String(value)` | — | `console.warn` once per refName |
| F6 | Two settings panes race on save | Existing per-field versioned save queue | Last write wins on `workItemDisplayConfig` only | Existing `createProjectSettingsSaveQueue` behaviour | — |
| F7 | Config references a field only valid for some types | `validWorkItemTypes` on the metadata | Row skipped for other types; settings UI shows "only on: Bug, Issue" | — | — |
| F8 | Very large `extraFieldRefNames` list bloats the URL | > ~20 extras | — | Switch `queryWorkItems` to the POST `workitemsbatch` path (already implemented for `getWorkItemsByIds`) | — |

## Data model / migrations

```ts
// electron/database/migrations/091_project_work_item_display_config.ts
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('projects')
    .addColumn('workItemDisplayConfig', 'text')   // JSON, nullable, no default
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('projects').dropColumn('workItemDisplayConfig').execute();
}
```

Register in `electron/database/migrator.ts`. Add
`workItemDisplayConfig: string | null` to `ProjectTable` in
`electron/database/schema.ts`. No index (read only with the project row). No
backfill (decision 5).

`electron/database/repositories/projects.ts`:

- `parseWorkItemDisplayConfig(raw: string | null): WorkItemDisplayConfig | null` — try/catch + `isWorkItemDisplayConfig`, `console.warn` and return `null` on failure (F1), mirroring `parseWorkItemTitleParser`.
- `serializeWorkItemDisplayConfig(v: WorkItemDisplayConfig | null): string | null`.
- `serializeWorkItemDisplayConfigUpdate` — only writes the key when `!== undefined`, mirroring `serializeWorkItemTitleParserUpdate`.

Saved-config shape:

```jsonc
{
  "version": 1,
  "detail": {
    "rows": [
      { "refName": "System.AssignedTo", "visible": true },
      { "refName": "System.State", "visible": true },
      { "refName": "Custom.Severity", "visible": true },
      { "refName": "Microsoft.VSTS.Common.Priority", "visible": false }
    ],
    "tabs": [
      { "id": "description", "visible": true },
      { "id": "acceptanceCriteria", "visible": true },
      { "id": "reproSteps", "visible": true },
      { "id": "comments", "visible": true },
      { "id": "history", "visible": false },
      { "id": "testCases", "visible": true }
    ]
  },
  "board": { "rows": [ { "refName": "Microsoft.VSTS.Scheduling.StoryPoints", "visible": true } ] },
  "overridesByType": { "Bug": { "rows": [ … ], "tabs": [ … ] } }
}
```

Size bounds (validated in the type guard, mirroring the title-parser constants):
`MAX_ROWS = 40`, `MAX_OVERRIDES = 20`, `MAX_REFNAME_LENGTH = 200`.

## Interfaces

```ts
// shared/work-item-field-types.ts  (NEW)
export type AzureFieldRefName = string;              // 'System.Title', 'Custom.Severity'
export interface WorkItemIdentity { displayName: string; uniqueName?: string; imageUrl?: string }
export type WorkItemFieldValue = string | number | boolean | WorkItemIdentity | null;
export type WorkItemFieldType =
  | 'string' | 'plainText' | 'html' | 'integer' | 'double'
  | 'dateTime' | 'boolean' | 'identity' | 'treePath' | 'picklistString';

export interface WorkItemFieldMetadata {
  refName: AzureFieldRefName;
  name: string;
  type: WorkItemFieldType;
  readOnly: boolean;
  validWorkItemTypes: string[];
}

export const FIELD_TITLE = 'System.Title';
export const FIELD_WORK_ITEM_TYPE = 'System.WorkItemType';
export const FIELD_TEAM_PROJECT = 'System.TeamProject';
export const FIELD_STATE = 'System.State';
export const FIELD_ASSIGNED_TO = 'System.AssignedTo';
export const FIELD_DESCRIPTION = 'System.Description';
export const FIELD_ACCEPTANCE_CRITERIA = 'Microsoft.VSTS.Common.AcceptanceCriteria';
export const FIELD_REPRO_STEPS = 'Microsoft.VSTS.TCM.ReproSteps';
export const FIELD_STEPS = 'Microsoft.VSTS.TCM.Steps';
export const FIELD_CHANGED_DATE = 'System.ChangedDate';
export const FIELD_BOARD_COLUMN = 'System.BoardColumn';
export const FIELD_BOARD_COLUMN_DONE = 'System.BoardColumnDone';
export const FIELD_TAGS = 'System.Tags';
export const FIELD_PRIORITY = 'Microsoft.VSTS.Common.Priority';
export const FIELD_STACK_RANK = 'Microsoft.VSTS.Common.StackRank';
export const FIELD_STORY_POINTS = 'Microsoft.VSTS.Scheduling.StoryPoints';
export const FIELD_ITERATION_PATH = 'System.IterationPath';

/** Always fetched, regardless of display config (decision 7). */
export const CORE_FIELD_REFNAMES: readonly AzureFieldRefName[];
/** Inline-editable in v1 (decision 12). */
export const EDITABLE_FIELD_REFNAMES: readonly AzureFieldRefName[];
/** Built-in metadata for the core fields, used when Azure metadata is unavailable (F4). */
export const CORE_FIELD_METADATA: Readonly<Record<AzureFieldRefName, WorkItemFieldMetadata>>;

export function getFieldValue(item: AzureDevOpsWorkItem, ref: AzureFieldRefName): WorkItemFieldValue;
export function getStringField(item: AzureDevOpsWorkItem, ref: AzureFieldRefName): string | undefined;
export function getNumberField(item: AzureDevOpsWorkItem, ref: AzureFieldRefName): number | undefined;
export function getBooleanField(item: AzureDevOpsWorkItem, ref: AzureFieldRefName): boolean | undefined;
export function getIdentityField(item: AzureDevOpsWorkItem, ref: AzureFieldRefName): WorkItemIdentity | undefined;

export function getTitle(item: AzureDevOpsWorkItem): string;
export function getWorkItemType(item: AzureDevOpsWorkItem): string;
export function getState(item: AzureDevOpsWorkItem): string;
export function getTeamProject(item: AzureDevOpsWorkItem): string | undefined;
export function getAssignee(item: AzureDevOpsWorkItem): WorkItemIdentity | undefined;
export function getDescriptionHtml(item: AzureDevOpsWorkItem): string | undefined;
export function getAcceptanceCriteriaHtml(item: AzureDevOpsWorkItem): string | undefined;
export function getReproStepsHtml(item: AzureDevOpsWorkItem): string | undefined;
export function getChangedDate(item: AzureDevOpsWorkItem): string | undefined;
export function getBoardColumn(item: AzureDevOpsWorkItem): string | undefined;
export function getBoardColumnDone(item: AzureDevOpsWorkItem): boolean | undefined;
export function getTags(item: AzureDevOpsWorkItem): string[];          // splits 'a; b' (decision 21)
export function getPriority(item: AzureDevOpsWorkItem): number | undefined;
export function getStackRank(item: AzureDevOpsWorkItem): number | undefined;
export function getStoryPoints(item: AzureDevOpsWorkItem): number | undefined;
export function getIterationPath(item: AzureDevOpsWorkItem): string | undefined;

/** Normalizes one raw Azure field value (identity objects → WorkItemIdentity). */
export function normalizeFieldValue(raw: unknown): WorkItemFieldValue;
```

```ts
// shared/work-item-display-config-types.ts  (NEW)
export const WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS = 40;
export const WORK_ITEM_DISPLAY_CONFIG_MAX_OVERRIDES = 20;
export const WORK_ITEM_DISPLAY_CONFIG_MAX_REFNAME_LENGTH = 200;

export type WorkItemTabId =
  | 'description' | 'acceptanceCriteria' | 'reproSteps'
  | 'comments' | 'history' | 'testCases';

export interface WorkItemRowConfig { refName: AzureFieldRefName; visible: boolean }
export interface WorkItemTabConfig { id: WorkItemTabId; visible: boolean }
export interface WorkItemDetailLayout { rows: WorkItemRowConfig[]; tabs: WorkItemTabConfig[] }

export interface WorkItemDisplayConfig {
  version: 1;
  detail: WorkItemDetailLayout;
  board: { rows: WorkItemRowConfig[] };
  overridesByType: Record<string, WorkItemDetailLayout>;   // absent key ⇒ inherit detail
}

/** Exactly today's hardcoded layout (decision 5). */
export const DEFAULT_WORK_ITEM_DISPLAY_CONFIG: WorkItemDisplayConfig;

export function isWorkItemDisplayConfig(value: unknown): value is WorkItemDisplayConfig;
export function resolveDetailLayout(
  config: WorkItemDisplayConfig | null,
  workItemType: string,
): WorkItemDetailLayout;
export function resolveBoardRows(config: WorkItemDisplayConfig | null): WorkItemRowConfig[];
export function collectExtraFieldRefNames(config: WorkItemDisplayConfig | null): AzureFieldRefName[];
export function hashRefNames(refNames: AzureFieldRefName[]): string;   // sorted, stable
```

```ts
// electron/services/azure-devops-service.ts  (CHANGED)
export interface AzureDevOpsWorkItem {
  id: number;
  url: string;
  fields: Record<AzureFieldRefName, WorkItemFieldValue>;   // was the typed 17-key object
  testSteps?: TestStep[];
  parentId?: number;
  childIds?: number[];
  relatedWorkItemIds?: number[];
  linkedPrs?: LinkedPr[];
  relatedTestCaseIds?: number[];
}

getWorkItemTypeFields(params: {
  providerId: string;
  azureProjectId: string;
}): Promise<WorkItemFieldMetadata[]>;

queryWorkItems(params: { /* existing */ extraFieldRefNames?: AzureFieldRefName[] }): Promise<AzureDevOpsWorkItem[]>;
getWorkItemById(params: { /* existing */ extraFieldRefNames?: AzureFieldRefName[] }): Promise<AzureDevOpsWorkItem | null>;
getWorkItemsByIds(params: { /* existing */ extraFieldRefNames?: AzureFieldRefName[] }): Promise<AzureDevOpsWorkItem[]>;
```

```ts
// electron/preload.ts + electron/ipc/handlers.ts
window.api.azureDevOps.getWorkItemTypeFields(params: {
  providerId: string; azureProjectId: string;
}): Promise<WorkItemFieldMetadata[]>;                       // channel 'azureDevOps:getWorkItemTypeFields'
// queryWorkItems / getWorkItemById / getWorkItemsByIds gain optional extraFieldRefNames
```

```ts
// src/hooks/use-work-items.ts
export function useWorkItemTypeFields(params: {
  providerId: string | undefined;
  azureProjectId: string | undefined;
}): UseQueryResult<WorkItemFieldMetadata[]>;
// queryKey ['work-item-type-fields', providerId, azureProjectId], staleTime 60 * 60 * 1000

export function useWorkItemFieldMetadataMap(params: {
  providerId: string | undefined;
  azureProjectId: string | undefined;
}): Record<AzureFieldRefName, WorkItemFieldMetadata>;        // memoized, CORE_FIELD_METADATA merged in

// useWorkItems / useWorkItemById / useWorkItemsByIds gain extraFieldRefNames,
// appended to their query keys as hashRefNames(extras)
```

```tsx
// src/features/work-item/ui-work-item-field-rows/index.tsx  (NEW)
export function WorkItemFieldRows(props: {
  workItem: AzureDevOpsWorkItem;
  rows: WorkItemRowConfig[];
  metadata: Record<AzureFieldRefName, WorkItemFieldMetadata>;
  variant: 'detail' | 'board';
  editable?: boolean;                    // detail only; only EDITABLE_FIELD_REFNAMES react
  onEditField?: (params: { refName: AzureFieldRefName; value: WorkItemFieldValue }) => void;
}): JSX.Element;

// src/features/project/ui-work-item-display-settings/index.tsx  (NEW)
export function WorkItemDisplaySettings(props: {
  project: Project;
  value: WorkItemDisplayConfig | null;
  onChange: (next: WorkItemDisplayConfig) => void;
}): JSX.Element;
```

```ts
// shared/types.ts
Project.workItemDisplayConfig: WorkItemDisplayConfig | null;
NewProject.workItemDisplayConfig?: WorkItemDisplayConfig | null;
UpdateProject.workItemDisplayConfig?: WorkItemDisplayConfig | null;
```

## State

| State | Owner | Lifetime | Invalidation |
| --- | --- | --- | --- |
| `workItemDisplayConfig` | SQLite `projects` row; read through `useProject` | Persistent | React Query `['projects']` on save (existing project-update path) |
| Draft config while editing | Local `useState` in `ui-work-item-display-settings`, flushed by the existing project settings save queue via `markFieldDirty('workItemDisplayConfig')` | Until pane unmount / save | — |
| Field metadata | React Query `['work-item-type-fields', providerId, azureProjectId]` | 1h stale, in-memory | Manual refresh in the settings pane |
| Work items | React Query `['work-items', providerId, …, hashRefNames(extras)]` | Existing | Key change on config edit (decision 8) |

No new Zustand store. Nothing here needs cross-route UI state.

## Error handling

Covered per mode in the **Failure paths** table (F1–F8). Two rules bind the
whole feature:

1. **The detail panel never renders a broken row.** Every unresolvable refName
   is skipped; the settings pane is the single place that explains why.
2. **A bad config never blocks work items from loading.** Parse failure → `null`
   → default layout (F1); a rejected `fields=` set → retry with the core set
   (F3); missing metadata → built-in `CORE_FIELD_METADATA` + text fallback (F4).

## Security

- No new secrets. `getWorkItemTypeFields` reuses `getProviderAuth`; the PAT is
  never exposed to the renderer.
- `azureProjectId` and every refName are interpolated into Azure REST paths and
  the `fields=` query param — refNames are validated against
  `/^[A-Za-z0-9_.]{1,200}$/` in the type guard and URL-encoded at the call site.
  Nothing reaches WIQL, so no WIQL injection surface is added.
- `html`-typed field values are rendered through the existing sanitization path
  used by `shared/work-item-html.ts` / `azure-html-to-markdown.ts` — never
  `dangerouslySetInnerHTML` on a raw custom field.
- Authorization is unchanged: visibility is per-project config, and the PAT's
  own Azure permissions remain the only access control. A user who cannot read a
  field in Azure gets no value back regardless of config.
- Config JSON is bounded (rows/overrides/refName length) so a hand-edited DB row
  cannot produce an unbounded fetch set.

## Test strategy

**Unit (vitest)**

- `shared/work-item-display-config-types.test.ts` — `isWorkItemDisplayConfig`
  accepts the starter config and rejects: wrong `version`, non-array `rows`,
  refName over the length cap, refName failing the charset regex, over-cap rows
  and overrides, unknown `tabs[].id`.
- `resolveDetailLayout` — override hit, override miss (inherits `detail`),
  `null` config (returns `DEFAULT_WORK_ITEM_DISPLAY_CONFIG.detail`).
- `collectExtraFieldRefNames` — excludes core refNames, dedupes across
  `detail` + `board` + every override, includes refNames that are `visible:false`
  **only if** they are also visible somewhere else (hidden-everywhere ⇒ excluded).
- `hashRefNames` — order-independent and stable.
- `shared/work-item-field-types.test.ts` — `normalizeFieldValue` on identity
  objects / strings / numbers / null; `getTags` on `''`, `'a'`, `'a; b'`,
  `'a;b'`; every accessor returns `undefined` on a missing key.
- `electron/database/repositories/projects.test.ts` (extend) — round-trip save,
  corrupt JSON ⇒ `null` (F1), `undefined` in `UpdateProject` leaves the column
  untouched.

**Integration (main process, mocked fetch)**

- `azure-devops-service.test.ts` (extend): fetch set is `core ∪ extras`;
  extras that duplicate core don't double up; `fields` maps to a refName record
  with normalized identities; a 400 on the extras call retries with core only
  and still returns items (F3); `getWorkItemTypeFields` merges across multiple
  work item types and dedupes by refName with `validWorkItemTypes` unioned.

**Component**

- `ui-work-item-field-rows` — renders one case per `WorkItemFieldType`; skips a
  refName absent from metadata (F2); skips a refName whose
  `validWorkItemTypes` excludes the item's type (F7); falls back to
  `String(value)` on a type mismatch (F5); `editable` affects only
  `EDITABLE_FIELD_REFNAMES`.
- `ui-work-item-display-settings` — marks an unavailable refName, reorder
  produces the expected `rows[]` order, adding then removing a type override
  round-trips to the original config.

**Manual**

- A project with no config: preview, feed modal, and board must look unchanged.
- A project with a real custom field: appears in the picker, renders by type,
  survives an app restart, and editing the config refetches work items once.

## Rollout & rollback

- **No feature flag.** `NULL` config is the flag: every existing project keeps
  today's layout until someone opens the pane (decision 5).
- **Order:** migration 091 → shared types + accessors → service/IPC → codemod the
  23 consumer files → renderer → settings pane. The accessor layer lands before
  the consumers so the codemod compiles in one step.
- **Backward compatibility:** the `fields` shape change is internal to this app
  (main ↔ renderer over IPC in the same build) — there is no external consumer
  and no persisted copy of the old shape to migrate. Renderer caches in
  `src/cache/` hold work items, so bump their cache version key to avoid
  deserializing old-shape entries.
- **Rollback:** `down()` drops the column; saved configs are lost but nothing
  else breaks, since every read path already handles `null`.

## Open risks

1. **The 257-site codemod is the bulk of the risk.** It is mechanical but wide,
   and `pnpm ts-check` is the main safety net — the accessors are typed
   precisely so a missed site fails to compile rather than silently returning
   `undefined`. Every accessor returning `T | undefined` (rather than `T`) is
   deliberate for this reason.
2. **Renderer cache shape.** `src/cache/` persists work items; if the version
   key bump is missed, old-shape entries deserialize into a record with no
   refName keys and every field reads blank. Must be verified manually on an
   upgrade, not just a fresh install.
3. **Field metadata volume.** A process template with many work item types means
   one API call per type on first open of the settings pane. Acceptable at 1h
   stale time, but worth measuring on a large org before widening the cache.
4. **`validWorkItemTypes` semantics** are inferred from the per-type endpoint
   rather than declared by Azure; if a field is valid for a type we never
   queried, it will be treated as unavailable for that type (F7) and silently
   skipped. Detectable only via the settings pane's "only on:" hint.
5. **Unifying preview and modal** touches ~3000 lines of existing UI. The two
   panels differ in more than field rows (editing affordances, tab chrome); the
   unification is scoped to the metadata rows region only, and any further
   convergence is explicitly out of scope.

---

## Revision — 2026-09-19 (during implementation, after T15 blocked)

### What the original design got wrong

`## Architecture` and `## Data flow` assumed each of the three surfaces has a
"metadata row region" that one generic renderer could replace, and that
`DEFAULT_WORK_ITEM_DISPLAY_CONFIG` could reproduce all of them. T15 stopped
before writing code and the claim was verified against the source:

| Surface | Fields rendered today | Shape |
| --- | --- | --- |
| `ui-work-item-preview` *editorial* (`:419-524`) | AssignedTo, State, BoardColumn, Iteration, Points, Priority, Tags | horizontal wrap of live editors |
| `ui-work-item-preview` *non-editorial* (`:630-679`) | Assignee, State, Priority, Tags | horizontal wrap |
| `feed/ui-work-item-details` (`:814-905`) | State, BoardColumn, Owner, Points, Iteration, Tags — **no Priority**, different order | horizontal wrap of live editors |
| `ui-work-item-board/card-board-item` (`:138-330`) | avatar, `#id`, priority badge, out-of-sprint badge, tag chips | badges/chips, **not rows** |

So there are **four** layouts, not three; the default matched exactly one; and
none of them is a vertical label/value stack. Worse, every detail-panel field is
rendered by a *live inline editor* (`MetadataDropdown`, `WorkItemTagEditor`,
`WorkItemBoardColumnEditor`, `EditableStateBadge`, `EditableOwner`), so the
original T15 instruction would have deleted inline editing — which the same task
block forbade. The two constraints were unsatisfiable as written.

### Decisions added

| # | Decision | Chosen | Why | Rejected |
| --- | --- | --- | --- | --- |
| 22 | Inline editing under the config-driven renderer | `WorkItemFieldRows` **hosts the existing editor components** for `EDITABLE_FIELD_REFNAMES`, rather than rendering read-only text plus a click-to-edit button | Inline editing is core UX; losing it is a bigger regression than the feature is a gain | Read-only rows (rejected: downgrade); leaving panels untouched (rejected: hiding/reordering a built-in field would do nothing, failing half the original ask) |
| 23 | Default layout per surface | `DEFAULT_*` becomes **per-surface**: preview-editorial, preview-non-editorial, feed modal, board each keep their current layout as their own default | An unconfigured project is byte-identical on every surface — the v1 acceptance criterion — while a *configured* project converges on one shared `detail` list, which is the uniformization asked for in design round 1 | One shared default (rejected: changes 3 of 4 surfaces for projects that configured nothing) |
| 24 | Preview's two variants | Each keeps its own default; neither changes until configured | Same reasoning as 23 | Editorial layout canonical, non-editorial gains 3 rows |
| 25 | Board cards | Config controls **which existing card elements show and in what order**, keeping avatar / badge / chip rendering. Board cards are NOT label/value rows | A card is space-constrained chrome; forcing rows would make cards worse. Consistent with decision 3 ("board configured separately") | Same row renderer as detail panels; dropping board from scope |

### Interface changes

```ts
// shared/work-item-display-config-types.ts
export type WorkItemDisplaySurface =
  | 'preview-editorial' | 'preview-readonly' | 'feed-modal';

export const DEFAULT_DETAIL_LAYOUT_PREVIEW_EDITORIAL: WorkItemDetailLayout;
export const DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY: WorkItemDetailLayout;
export const DEFAULT_DETAIL_LAYOUT_FEED_MODAL: WorkItemDetailLayout;

// CHANGED — gains a surface param used only when config is null
export function resolveDetailLayout(
  config: WorkItemDisplayConfig | null,
  workItemType: string,
  surface: WorkItemDisplaySurface,
): WorkItemDetailLayout;
```

`resolveDetailLayout` returns that surface's default when `config` is `null`;
once a config exists, every detail surface resolves the same `config.detail`
(plus any per-type override). That is what makes "unchanged until configured,
converged once configured" hold simultaneously.

`resolveBoardRows` is unchanged — `board.rows` stays a refName list. The board
card maps each refName onto its existing chrome (`System.AssignedTo` → avatar,
`Microsoft.VSTS.Common.Priority` → badge, `System.IterationPath` →
out-of-sprint badge, `System.Tags` → chips) rather than rendering rows.

```tsx
// ui-work-item-field-rows — gains editor hosting
export function WorkItemFieldRows(props: {
  workItem: AzureDevOpsWorkItem;
  rows: WorkItemRowConfig[];
  metadata: Record<AzureFieldRefName, WorkItemFieldMetadata>;
  variant: 'detail' | 'board';
  editable?: boolean;
  onEditField?: (params: { refName: AzureFieldRefName; value: WorkItemFieldValue }) => void;
  /** NEW: per-refName editor renderers supplied by the host panel. */
  editors?: Partial<Record<AzureFieldRefName, (ctx: {
    workItem: AzureDevOpsWorkItem;
    value: WorkItemFieldValue;
  }) => React.ReactNode>>;
}): JSX.Element;
```

Editor *components* stay owned by their panels and are injected, so
`ui-work-item-field-rows` acquires no dependency on panel-specific editors and
the two panels can converge without one owning the other's components.

### Still out of scope

Unchanged from the original list. Additionally: converging the preview and feed
modal beyond the metadata-row region (tab chrome, comments/history/test-case
tabs, editing affordances themselves) remains explicitly out of scope.

---

## Revision 2 — 2026-09-19: converge the two detail surfaces' editors

Design Risk 5 and decision 3 scoped convergence to the metadata-row *region*
and explicitly left editing affordances alone. The user asked to go further:
both surfaces should use the same input components.

### Survey (measured, not assumed)

~500 LOC of duplicated editor logic. Only `System.BoardColumn` was converged.
The feed modal already imported `EditableMetadataValue` out of
`ui-work-item-preview/index.tsx` — a surface file importing another surface
file, which is the smell that confirmed the need for a shared home.

| Field | Preview (A) | Feed modal (B) |
| --- | --- | --- |
| `System.Title` | inline edit + non-empty validation | read-only `<h1>` |
| `System.AssignedTo` | `MetadataDropdown` 119 LOC · bordered pill · keyed by **display name** · cannot unassign · optimistic | `EditableOwner` 103 LOC · borderless · keyed by **uniqueName** · explicit Unassigned · fire-and-forget |
| `System.State` | `MetadataDropdown` · `updateWorkItemField` · plain pill | `EditableStateBadge` 67 LOC · `updateWorkItemState` (optimistic) · coloured `Chip` + ring |
| `System.BoardColumn` | shared editor, `variant="metadata"` | shared editor, `variant="details"` |
| `System.IterationPath` | `MetadataDropdown` · flat options · hidden when empty | `EditableIteration` 83 LOC · 2-line rows + "Current" · always shown |
| `…StoryPoints` | `EditableMetadataValue` + bordered wrapper | **imports A's component** + borderless wrapper |
| `…Priority` | `EditableMetadataValue`, validates 1–4 | **no editor** |
| `System.Tags` | shared editor + `suggestions` | shared editor, `suggestions={[]}` |

Also duplicated outright: `ExpandableTestCase` (~94 LOC), `TabButton` /
`FeedTabButton` (~37 LOC), `WorkItemTypeIcon` (the feed's copy duplicates an
existing export in `ui-work-item-shared.tsx`).

### Decisions added

| # | Decision | Chosen | Why | Rejected |
| --- | --- | --- | --- | --- |
| 26 | Where converged editors live | New `src/features/work-item/ui-work-item-field-editors/`, one implementation per field, injected by both panels through the existing `editors` prop | Keeps the `WorkItemFieldRows` contract untouched; ends a surface file importing another surface file | Leaving them in the preview and importing across; a `common/ui` home (too generic — these are work-item-specific and hook-coupled) |
| 27 | Visual style | **Borderless triggers everywhere** (the modal's style) | User preference; lighter and denser. The preview header loses its bordered `h-8` pills — the most visible change in this revision | A `variant` prop per surface (recommended, since `WorkItemBoardColumnEditor` already does exactly that); bordered pills everywhere |
| 28 | Owner option model | The modal's: keyed by `uniqueName`/email, with an explicit "Unassigned" entry | Display names are not unique and can collide between two real people; the preview also gains the ability to unassign | Display-name keying (the preview's); keeping two components |
| 29 | State editor | The modal's coloured `Chip` + semantic ring, saving through the optimistic `updateWorkItemState` | Better affordance, and the only optimistic path of the two — the preview was using `updateWorkItemField`, which has no optimistic update for state | Preview's plain pill; keeping both |
| 30 | Capability gains | All five: modal gains Priority editing, tag autocomplete **and inline title editing**; preview gains the richer iteration dropdown and shows Iteration even when empty | Convergence should level up both surfaces, not intersect down to the lesser | Intersecting to the common subset |
| 31 | Scope | Editors **plus** the other duplicated components (`ExpandableTestCase`, `TabButton`, `WorkItemTypeIcon`) | ~130 LOC more for a meaningfully cleaner end state | Editors only |

### Blast radius

- `WorkItemPreview` is also rendered by the **work-activity overlay**
  (`ui-work-activity-overlay/index.tsx:1039`, read-only, non-editorial), so the
  preview's read-only path reaches a third surface.
- `getOwnerOptions` is imported by `src/lib/work-item-owner-options.test.ts`
  from `@/features/feed/ui-work-item-details`; moving it moves that import.
- `WorkItemFieldRows`' `editors` contract is unchanged, so its 29 tests and the
  board variant are unaffected.

### Still out of scope

Tab chrome and the comments / history / test-case tab *structure*; the display
config itself; per-field custom labels (decision 2 still stands).
