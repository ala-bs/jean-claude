# Project-effective model profile selection — Design

Date: 2026-09-21

## Problem

The project policy resolver already selects the first allowed profile when the
global profile is disallowed, but the profile switcher header still renders the
global profile. A restricted project can therefore display one profile while
resolving another.

## Decision

Use `useEffectiveModelProfile(projectId)` as the switcher's displayed and
selected profile. Keep the global profile list and existing activation action
unchanged. The renderer hook uses the first available profile as the UI default
when there is no usable active profile; under `enforce`, the first permitted
profile remains preferred. Main-process resolution keeps its existing fallback
semantics for roles that intentionally have no profile.

```text
global active + project policy
              │
              ▼
       pickEffectiveProfile
              │
              ▼
       switcher display/mark
```

## Interfaces

- `pickEffectiveProfile({ profiles, activeProfileId, policy })` remains the
  shared selection function used by main and renderer.
- `ModelProfileSwitcher` reads `profile` from
  `useEffectiveModelProfile(projectId)` for its trigger and `aria-current`.
- New-task model initialization passes `effectiveProfileId` to the resolver so
  the displayed default and created-task model cannot diverge.

## Verification

- Shared tests cover defaulting with no active profile.
- Switcher tests cover an enforced project displaying its permitted profile
  even when another profile is globally active.
- Run the repository-required install, test, lint-fix, typecheck, and final
  lint commands.
