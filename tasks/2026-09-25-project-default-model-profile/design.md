# Project Default Model Profile — Design
Date: 2026-09-25

## Problem

Projects can already store a non-enforcing `prefer` policy with a pinned
profile, but the UI calls it “Starting profile” and the code describes it as a
preference. The intended product concept is a project default: new task flows
should resolve to that profile while still allowing an explicit per-task
override.

## Users & success criteria

- A user can choose a project default profile without enforcing it.
- The new-task overlay shows and resolves that profile for an untouched draft.
- Users can still override the model for one task.
- Existing `prefer` policy files and database values remain valid.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Non-enforcing pinned-profile behavior already exists | `shared/model-profiles.ts`, `resolveModelForRole` |
| Project-aware profile resolution is shared by main and renderer | `pickEffectiveProfile`, `useEffectiveModelProfile` |
| New-task overlay resolves untouched model fields from the effective profile | `src/features/new-task/ui-new-task-overlay/index.tsx` |
| Project editor exposes `prefer` as “Start this project on a profile” | `src/features/project/ui-project-model-policy/index.tsx` |

## Decisions

- Keep the stored mode name `prefer` for backward compatibility with committed
  `.jean-claude/model-policy.json` files and the database column.
- Rename the user-facing mode to “Project default profile” and its field to
  “Default profile”; explain that users can still switch profiles.
- Preserve explicit draft overrides. A project default applies only when the
  new-task draft has not selected a model/profile override.
- Add regression coverage proving a `prefer` pin resolves in the new-task
  model-selection path.

## Architecture

```text
Project policy (prefer + pinnedProfileId)
             │
             ▼
pickEffectiveProfile / resolveModelForRole
             │
             ├── effective profile shown by ModelProfileSwitcher
             └── untouched new-task draft model
                         │
                         └── explicit override still wins
```

## Interfaces

No public type or persistence interface changes. `ProjectModelPolicy` remains:

```ts
{ mode: 'inherit' | 'prefer' | 'enforce'; pinnedProfileId?: string }
```

The existing `resolveAgentModelSelection` contract remains the seam tested by
the new-task overlay:

```ts
resolveAgentModelSelection({
  profiles,
  activeProfileId,
  policy,
  enabledBackends,
  draft,
}): ResolvedModel
```

## Data flow and failures

1. The project policy is loaded from the committed repo file, then the project
   database value, as before.
2. `prefer` plus an existing `pinnedProfileId` selects that profile.
3. The overlay resolves the agent role from that effective profile when the
   draft is untouched.
4. If the pinned profile was deleted, existing fallback behavior uses the
   global active profile; this is safe because `prefer` is not enforcement.
5. If a user has explicitly changed the draft model, the override remains the
   source of truth.

## Verification

- Unit test project-default resolution in `src/lib/default-models.test.ts`.
- Run the required repository checks: install, tests, lint auto-fix, TypeScript
  check, and final lint.
