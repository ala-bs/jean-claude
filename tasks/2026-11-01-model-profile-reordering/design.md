# Model profile reordering — Design
Date: 2026-11-01

## Problem
Model profiles are displayed in saved array order, but Settings has no way to change that order. Position also determines the existing `⌘⌥1–9` profile shortcuts.

## Users & success criteria
Someone managing multiple model profiles can move a profile in Settings, see the new order after reopening the app, and use the shortcut for its new position. Moving a profile does not change its ID, bindings, or active state.

## Codebase findings
| Finding | Evidence |
| --- | --- |
| Profiles are saved as an ordered `ModelProfile[]` setting. | `shared/model-profiles.ts`, `src/hooks/use-model-profiles.ts` |
| The Settings rail renders that array directly. | `src/features/settings/ui-model-profiles-settings/index.tsx` |
| The profile switcher and global commands use array positions for shortcuts. | `src/features/agent/ui-model-profile-switcher/index.tsx`, `src/common/hooks/use-commands/model-profile-commands.ts` |
| Other Settings lists use dnd-kit for pointer and keyboard sorting. | `src/features/project/ui-work-item-display-settings/status-chip-rules.tsx` |

## Decisions
| Decision | Chosen | Why | Alternative |
| --- | --- | --- | --- |
| Persistence | Rewrite the existing ordered `modelProfiles` array | No schema or IPC change is needed. | Separate order setting adds synchronization work. |
| Controls | Drag handle plus move up/down buttons | Matches existing sorting and gives a direct keyboard action. | Drag only is harder to verify and discover. |
| Shortcut mapping | Follow visible order | This is the existing position based mapping. | Separate shortcut positions would be surprising. |

## In scope (v1)
Reorder profiles in Settings, persist the order, keep shortcut positions aligned, and preserve each profile's identity and active selection.

## Out of scope
Renumbering shortcuts independently of the list and changing project profile policies.

## Architecture and data flow
```text
Profile rail ──► arrayMove(profiles) ──► useUpdateModelProfiles
                                      └──► modelProfiles setting
                                                └──► Settings rail and shortcut consumers
```
The row uses `useSortable` and a dedicated drag handle. The rail handles drop and move button actions, validates the target position, and passes the reordered array to the existing profile setting mutation. A failed setting write leaves the stored order intact; the next settings query restores it.

## Data model / migrations
No new fields or migration. Existing `ModelProfile.id` values and profile objects are preserved.

## Interfaces
`ProfileRail.onReorder(profiles: ModelProfile[]): void` writes through `useUpdateModelProfiles().mutate({ key: 'modelProfiles', value: profiles })`.

## Error handling and security
Ignore drops without a valid target and moves beyond the list bounds. The existing settings validation and IPC boundary continue to validate the array. This feature adds no external input or permission surface.

## Test strategy
The Settings component test verifies moving a profile writes the new ID order and retains the active profile. Existing model profile tests cover setting use and shortcut behavior. Run the repository test, lint, and TypeScript gates.

## Rollout and rollback
No migration or feature flag. Removing the controls restores the previous Settings behavior without changing saved profile data.

## Open risks
The Settings mutation refreshes the list after a successful write; order changes may appear after a short delay.
