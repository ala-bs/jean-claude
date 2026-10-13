# Feature-map file readiness — Design
Date: 2026-09-20

## Problem

Feature-map generation already instructs the agent to write YAML to a
task-specific temporary file, but the UI treats `step.status === "completed"`
as the only readiness signal. The app does not validate the output file after
each agent turn, so the Review diff and Save actions are unavailable or can
present a misleading state even when the expected artifact is present.

The source of truth should be the requested file, not model text or a special
JSON response block.

## Users & success criteria

The user creates or refreshes a project feature map and needs to know when the
agent has produced a complete, valid draft.

Success criteria:

- The agent writes YAML to the existing task-specific temporary path:
  `.jean-claude/tmp/feature-map/<task-id>/feature-map.yaml`.
- After every feature-map agent turn, the main process checks that file.
- A valid non-empty feature map enables Review diff and Save immediately,
  independent of the step status.
- Missing, unreadable, empty, or malformed output disables those actions and
  shows a concrete reason while leaving the task usable for another turn.
- Save validates again before copying the draft into the canonical project
  file.
- Validation logs contain diagnostics sufficient to debug the workflow without
  logging the full feature-map contents.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Generation uses a task-specific temporary YAML path | `electron/services/project-feature-map-generation-service.ts` (`getFeatureMapTempPaths`) |
| The prompt already names the exact output file | `electron/services/project-feature-map-generation-service.ts` (`buildProjectFeatureMapPrompt`) |
| YAML parsing and normalization already exist | `electron/services/project-feature-map-generation-service.ts` (`parseProjectFeatureMapContent`, `normalizeFeatureMap`) |
| Save currently validates only when Save is invoked | `electron/services/project-feature-map-generation-service.ts` and `electron/ipc/handlers.ts` |
| The UI gates actions on completed step status | `src/features/task/ui-feature-map-save-action/index.tsx` |
| Step metadata is persisted as part of the step record | `shared/types.ts` (`FeatureMapStepMeta`), `electron/database/repositories/task-steps.ts` |
| Step upserts already propagate main-process changes to the renderer | `electron/services/cache-event-service.ts`, `src/cache/cache-listener.tsx` |
| The builtin skill already instructs agents to write valid YAML | `electron/services/builtin-skills-service.ts` (`project-feature-mapping`) |

## Guidelines applied

No `docs/guidelines/` tree exists in this worktree, so there are no project
guidelines to apply.

## Decisions

- Keep YAML as the output format. The current parser, schema, diff view, and
  canonical file all use YAML.
- Keep the task-specific temporary path. It prevents concurrent feature-map
  tasks from colliding and preserves the existing cleanup model.
- Detect readiness from the actual file and parsed schema, not from model text,
  fenced JSON, or step status.
- Validate after every feature-map agent turn and persist the result in step
  metadata. A step may be running while its latest draft is valid.
- Revalidate at Save time. Renderer state is advisory and the file may have
  changed since the last emitted step update.
- Invalid output is a recoverable draft state, not an agent-step failure. The
  user can continue the task or ask the agent to repair the file.
- A malformed top-level feature is invalid. The readiness validator must not
  silently drop malformed nodes and call the remaining partial map valid.
- Do not add a database migration. Feature-map metadata is already stored as
  serialized step metadata.

## Architecture

```text
Agent turn finalizes
        │
        ▼
FeatureMapDraftValidator
  ├─ read exact tempFilePath
  ├─ parse YAML
  ├─ validate complete feature-node shape
  └─ return valid | invalid + safe reason
        │
        ▼
Persist draftValidation in step.meta
        │
        ▼
emitStepUpsert(updatedStep)
        │
        ▼
FeatureMapSaveAction
  ├─ valid   → enable Review diff + Save Feature Map
  └─ invalid → disable actions + show reason
```

Responsibilities:

- `project-feature-map-generation-service.ts`: own output paths, parsing,
  normalization, strict draft validation, diffing, and canonical save.
- `agent-service.ts` / step-finalization seam: invoke validation at the end of
  every feature-map turn and emit the updated step.
- `shared/types.ts`: describe the persisted validation state in
  `FeatureMapStepMeta`.
- `FeatureMapSaveAction`: render readiness and reason from metadata, while
  retaining Save-time error handling.
- `electron/ipc/handlers.ts`: revalidate before saving and reject stale or
  invalid drafts.

## Interfaces

```ts
type FeatureMapDraftValidation =
  | {
      status: 'valid';
      validatedAt: string;
      featureCount: number;
    }
  | {
      status: 'invalid';
      validatedAt: string;
      error: string;
    };

interface FeatureMapStepMeta {
  projectId: string;
  projectPath: string;
  tempDir: string;
  tempFilePath: string;
  savedFilePath: string;
  saved?: boolean;
  draftValidation?: FeatureMapDraftValidation;
}

function validateProjectFeatureMapDraft(input: {
  tempFilePath: string;
}): Promise<FeatureMapDraftValidation>;
```

The validator returns `invalid` for:

- file not found;
- permission/read errors;
- invalid YAML;
- missing or empty `features`;
- malformed feature nodes, including malformed nested children;
- missing or invalid required node fields.

Error strings are concise and suitable for the UI. They must not include the
entire file contents.

The existing `saveProjectFeatureMapFromTemp` remains the canonical write API,
but it must use the same strict validation before writing. Its invalid-draft
error should include the validator reason.

## Data flow

### Valid draft

1. The feature-map task is created with its task-specific temp directory and
   output path.
2. The prompt tells the agent to write complete YAML to that path.
3. The agent turn reaches its terminal/finalization boundary.
4. The main process validates the exact path.
5. The step metadata is updated with `draftValidation.status = 'valid'` and the
   top-level feature count.
6. A step-upsert event updates the renderer.
7. Review diff and Save Feature Map become enabled immediately.
8. Save revalidates, writes canonical `.jean-claude/feature-map.yaml`, marks the
   step saved, invalidates the relevant renderer queries, and cleans up the
   temp directory.

### Invalid or missing draft

1. The turn reaches its terminal/finalization boundary.
2. Validation returns `invalid` with a concise reason.
3. The step metadata is updated and emitted.
4. Review and Save remain disabled; the UI displays the reason.
5. The task remains usable so the agent or user can continue and repair the
   file.

### Draft changes between validation and Save

Save runs validation again. If the file is now invalid, it rejects the save,
leaves the canonical map unchanged, updates the readiness metadata to the new
invalid result, and shows the error.

## State

`FeatureMapStepMeta.draftValidation` is the main-process-owned readiness state.
The renderer reads it from the reactive step cache. `step.status` continues to
describe agent execution and is not used to decide whether the draft is
submittable.

Older feature-map steps without `draftValidation` are treated as unknown/not
ready until a validation occurs. Saved steps continue to show the saved state.

## Error handling and logging

| Failure | Detect | Surface | Recover | Log |
| --- | --- | --- | --- | --- |
| Temp file missing | `readFile` ENOENT | `Feature map not ready: output file not found` | Continue the task and retry on next turn | step id, path, status |
| Invalid YAML | YAML parser error | `Feature map not ready: invalid YAML` plus concise reason where safe | Agent/user repairs file | step id and parser summary |
| Invalid schema | strict node validation | Missing/invalid field reason | Agent/user repairs file | step id, path, validation reason |
| File read failure | filesystem error | `Feature map not ready: could not read output file` | Retry next turn | step id, path, error code/message |
| File changes before Save | Save-time validation | Save error and readiness update | Review/repair and retry | step id and validation result |

Use the existing debug logger namespace. Do not log YAML contents, prompts, or
project secrets.

## Security

- Only read the `tempFilePath` stored in validated feature-map step metadata.
- Preserve the existing project-path consistency check before diff or save.
- Do not accept a renderer-supplied arbitrary output path.
- Continue writing only through the existing canonical path under the project’s
  `.jean-claude` directory.

## Test strategy

Unit tests for the generation service:

- valid complete YAML returns `valid` and the correct feature count;
- missing file returns `invalid` with a stable user-facing reason;
- invalid YAML returns `invalid`;
- empty `features` returns `invalid`;
- malformed top-level and nested nodes return `invalid` rather than being
  silently dropped;
- valid deep trees remain valid;
- Save rejects a draft that becomes invalid after readiness was emitted.

Service/integration tests:

- feature-map turn finalization persists validation metadata and emits a step
  upsert;
- invalid validation does not transition the step to errored;
- save revalidation prevents canonical-file writes;
- successful save preserves IDs and marks the step saved.

Renderer tests:

- valid metadata enables Review diff and Save while step status is running;
- invalid metadata disables both actions and shows the reason;
- unknown metadata remains not ready;
- saved metadata renders the saved state.

Manual verification:

```text
create task → agent writes valid YAML → Submit appears
                         │
                         └─ edit/delete YAML → Submit disappears with reason
```

## Rollout and rollback

No migration or feature flag is required. The change is backward compatible:
old steps without validation metadata are simply not ready until their next
turn or an explicit validation path updates them. Rollback consists of
reverting the code; existing task metadata and YAML files remain readable.

## Guideline candidates

None. The validation/readiness rule is specific to generated feature-map
artifacts and does not yet generalize beyond this workflow.
