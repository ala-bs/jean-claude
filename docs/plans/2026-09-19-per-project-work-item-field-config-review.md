# Per-project work item display configuration — Review

Date: 2026-09-19
Scope: `git diff $(git merge-base HEAD main)...HEAD` — 74 files, +8812/−1832, plus
the fixes below. Working tree was clean at review start.

Three rounds ran: five correctness lenses in parallel, a conformance pass against
the design/plan, then one independent verifier per surviving finding plus a pass
over the reviewer's own fixes.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | **Critical** | `pnpm lint` failing; preview crashes with "Rendered more hooks than during the previous render" when a null work item becomes non-null | A `useMemo` was added *below* the `if (!workItem) return` bail-out, so the component rendered 16 hooks on the null branch and 17 otherwise. The preview legitimately renders with a null item — the work-activity overlay passes one, and `getWorkItemById` returns `null` on a 404. **Self-inflicted in the previous turn**, and missed because the verification grepped for lint *warnings* while oxlint reported it as an *error* | Memo moved above the guard | `ui-work-item-preview/index.tsx` |
| 2 | **High** | A configured Priority/Tags row renders as nothing — no label, no value — on read-only surfaces | `WorkItemFieldRows` keyed both its visibility predicate and its render branch off the editor **function's existence**, not its output. Every read-only surface's editor returns `null`, so the row rendered an empty `contents` wrapper instead of falling through to the read-only value. Fires even with a `null` config, since `DEFAULT_DETAIL_LAYOUT_PREVIEW_READONLY` contains both fields | Editor node resolved once per row; falls back to `renderFieldValue` when empty | `ui-work-item-field-rows/index.tsx` |
| 3 | Medium | Toggling Comments / History / Test Cases off does nothing; the settings pane says "Hidden tabs never mount" | `isTabVisible` was consulted for only 3 of the 6 `WorkItemTabId`s. The other three tab buttons and panes were hardcoded | All six gated on both surfaces; a hidden tab can no longer stay selected; the preview resolves its layout above the bail-out so hiding Comments also stops the query | both detail surfaces |
| 4 | Medium | The same person appears twice in the preview's owner dropdown; clicking the unchecked copy writes a display name into `System.AssignedTo` | The preview built options from its display-name `assigneeOptions` prop while passing the assignee's `uniqueName` as the current value. `getOwnerOptions` keyed the pinned owner by email and the list entry by display name, so the de-dupe (which only merges the `me` slot) kept both — two value spaces in one list, violating decision 28 | Both surfaces now read `useWorkItemOwners`, already `uniqueName`-keyed. The dead `assigneeOptions` prop and its workspace argument removed rather than left as a silently ignored input | `ui-work-item-preview/`, `ui-work-item-workspace/` |
| 5 | Medium | A heavy config makes every detail panel in the project fail to load, permanently | `WORK_ITEM_FIELDS_URL_LIMIT` was declared but never read, so `getWorkItemById` built its `fields=` URL from the whole fetch set. The config guard caps each list individually, not the union across detail + board + every type override. Azure answers an over-long URL with a 400/414 whose body names no refName, which `detectExtraFieldFailure` cannot recognise — so the F3 retry never fires | Drop the param above an encoded-length budget. Lossless: with no `fields=` Azure returns the full payload, which contains every configured field anyway | `azure-devops-service.ts` |
| 6 | Low | A forward-slash iteration path renders in full instead of its leaf | The shared iteration editor split on `'\\'` only, where the preview it replaced and every other path consumer in the app split on `/[\\/]/` | Split on both separators | `work-item-iteration-editor.tsx` |
| 7 | Low | Nothing is highlighted as "assigned to me" for identities without a `uniqueName` | The convergence replaced the display-name comparison with a `uniqueName`-only one, but `normalizeFieldValue` only sets `uniqueName` when Azure supplies one | `uniqueName` still preferred; display name is now a case-insensitive fallback rather than the comparison being abandoned | `ui-work-item-list/index.tsx` |

### Found while reviewing the fixes above

The least-reviewed code in any change is the reviewer's. A dedicated pass over
fixes 1–7 found four more, all mine:

| # | Severity | Symptom | Root cause | Fix |
| --- | --- | --- | --- | --- |
| 8 | Medium | With every tab hidden, the feed modal renders the hidden tab's pane under an empty tab strip | The `effectiveTab` fallback `?? activeTab` returned the hidden tab when no tab was visible | Resolve to `null` and render no pane |
| 9 | Medium | Hiding Comments removes the tab but the comments **aside** still renders and fetches them | The aside is the comments tab in another layout and bypassed the gate entirely. Fix 3's commit message claiming "gates all six tabs" was an overclaim | `showCommentsAsidePane` gates the aside, the grid layout and the query |
| 10 | Low | Case differences between the identity feed and `getCurrentAzureUser` silently defeat the new highlight fallback | Fix 7's fallback compared case-sensitively where the `uniqueName` path lowercases both sides | Lowercase both sides |
| 11 | Low | Fix 5's cap fired from four extras onward, making the `extraFieldRefNames` plumbing nearly inert | It compared refName **count** against 20 while the fetch set always carries the 17 core refNames | Measure encoded length against a 1500-char budget |

## Before / after

```
 BEFORE — a row whose editor renders nothing disappears
   row ──► editorFor(refName) exists? ──yes──► <div class="contents">{ null }</div>
                                                      ▲
                                        no label, no value, field gone

 AFTER — the editor's OUTPUT decides
   row ──► editorNode = editor?.({...}) ?? null
             │
             ├─ node ────────────────► render the editor
             └─ null ──► metadata? ──► render the read-only value
                            └─ none ─► skip the row (F2)
```

```
 BEFORE — 3 of 6 tabs gated          AFTER — all six, and the aside
  description      ✓ gated            description      ✓
  acceptanceCriteria ✓ gated          acceptanceCriteria ✓
  reproSteps       ✓ gated            reproSteps       ✓
  comments         ✗ hardcoded        comments         ✓ (tab, pane AND aside)
  history          ✗ hardcoded        history          ✓
  testCases        ✗ hardcoded        testCases        ✓
                                      + a hidden tab can't stay selected
                                      + hiding Comments stops its query
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| The workspace never passes `extraFieldRefNames`, so configured custom fields are never fetched for the board and editorial preview | Backwards. `fields=` is sent **only when extras exist**; with none, no param is sent and Azure's default payload carries every field, which `mapWorkItemFields` copies wholesale. Quote: `let result = await requestOnce(extras.length > 0 ? fetchSet : null);` plus the comment "the default payload already contains every field". Not passing extras yields *more* data, not less. The claimed data path was also wrong — the editorial preview is fed `detailedWorkItem ?? selectedListWorkItem`, not the board list query |
| Tab **order** in `layout.tabs` is ignored | Real but not a defect: the plan specifies "visibility toggles for `detail.tabs`" (versus "drag-reorder + visibility toggles" for rows), and the settings pane exposes no tab reorder affordance. Ignoring order matches implemented scope |

## Parked — resolved by review feedback

| Finding | Decision | Outcome |
| --- | --- | --- |
| **F3's notice is never surfaced** | Add a toast error | **Done** (`0e2d5f53`). `partialFieldFailure` declared on the renderer type; the three work-item fetch hooks raise one error toast naming the rejected refNames, deduped by refName set for the renderer's lifetime. Verified red-first |
| **Hiding `System.Tags` on the board also removes tag-derived colour badges** | "Simply don't show the tags" | **No code change needed** — that is already the behaviour, and a colour-rule badge *is* a tag. Verified the non-tag chrome (title-derived scope labels, priority, avatar, out-of-sprint badge) is untouched, and the overflow badge that relocates carries only title-derived labels, never tags. Pinned by an expanded test so the decision is recorded rather than accidental |
| **The feed modal's Priority editor is unreachable until a config is saved** | "This is ok" | No change. Per-surface defaults (decision 23) stand |
| **Priority cannot be cleared** | Question asked — see the answer below | No change pending your call |

### On "Priority cannot be cleared"

Concretely: a work item has Priority 2, you clear the input and press Enter, and
you get *"Priority must be an integer from 1 to 4"* — the edit will not save, so
there is no way to unset priority once it has a value.

The cause is that `Number('') === 0`, and `0` fails the 1–4 range check. The
sibling Story Points editor in the same file handles it explicitly:

```ts
// Story points — clearable
validate={(value) => { if (value === '') return null; /* …non-negative int… */ }}
onSave={(value) => ({ value: value === '' ? null : Number(value) })}

// Priority — not clearable; no '' branch
validate={(value) => { const n = Number(value); /* …1–4… */ }}
onSave={(value) => ({ value: Number(value) })}
```

Making it clearable is a two-line change mirroring Story Points. It is left
unchanged because whether a blank priority is valid depends on the Azure process
template, and the behaviour was copied verbatim from the preview — so it is
pre-existing there and only newly reachable in the modal.

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `electron/database/migrations/078_pr_workspace_support.test.ts` fails (`client.setAuthorizer is not a function`) | Pre-existing on `main`, better-sqlite3 API drift, untouched by this branch |
| `electron/services/mobile-preview-process.test.ts` failed once under full-suite load | Confirmed flake: 11/11 in isolation, zero commits on this branch touch it |
| `src/lib/work-item-assignee-options.ts` is now fully dead (fix 4 removed its last runtime consumer) | Deleting a module plus its test is a judgment call; it is inert, not harmful |
| One bad work item type aborts the whole `getWorkItemTypeFields` (`Promise.all`, no per-type tolerance) | Real, but the fix is a design choice: partial metadata vs. fail-closed. Worth a follow-up |
| F4 drops extras entirely rather than rendering them as text when metadata is unavailable | The design's F4 row says "extras render as text"; the implementation skips them. A deliberate-looking simplification — flagging rather than changing behaviour under review |
| `ui-work-item-field-editors/` holds four components without an `index.tsx` | AGENTS.md wants one component per folder; adding an index would create the forbidden barrel. Needs splitting into four folders — pure churn, better done deliberately |
| Owner picker disables itself when `options.length <= 1` | Much less likely after fix 4 (options now come from the owners query), but an unassigned item in a project with no owners still renders a disabled control |
| Test gaps: no test covers tab gating; `board.rows` in the settings pane is untested; T14's reorder test exercises the arrow buttons, never `handleDragEnd` | Noted for follow-up; the behaviours themselves are correct |
| `card-readable.tsx`'s sprint suffix ignores `System.IterationPath` visibility, where `card-board-item.tsx` honours it | Inconsistency, not a regression versus `main` |

## Verification

All run after the final commit, output read:

```
pnpm ts-check   → clean (both tsconfig.web.json and tsconfig.node.json)
pnpm lint       → exit 0; 1 warning, pre-existing (feed-item-card.tsx sort-imports)
pnpm test       → Test Files 1 failed | 458 passed | 1 skipped (460)
                  Tests       1 failed | 5966 passed | 1 skipped (5968)
                  the single failure is the pre-existing 078 migration test
```

Baseline at review start was 5812 passing / 1 failing (the same 078 test), so the
branch adds ~156 passing tests and introduces no new failure.

Red-before-green was verified explicitly for the URL-cap fix (guard disabled →
test fails; restored → 63/63) and for the `Object.hasOwn` and editor-fallback
tests. Every row in the Fixes table was confirmed present on disk by grep after
the final commit.
