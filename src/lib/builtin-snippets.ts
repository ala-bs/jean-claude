import type { PromptSnippet } from '@shared/types';

export const BUILTIN_SNIPPETS: PromptSnippet[] = [
  {
    id: 'builtin-verify-implementation',
    name: 'Verify Implementation',
    description:
      'Assert implementation matches work item requirements and test cases',
    template: `Verify that the current implementation correctly satisfies the requirements described in the following work items.

{{#each workItems}}
<work_item id="{{this.id}}">
  <title>{{this.title}}</title>
{{#if this.description}}
  <expected_behavior>
    {{this.description}}
  </expected_behavior>
{{/if}}
{{#if this.testCases}}
  <test_cases>
{{#each this.testCases}}
    <test_case id="{{this.id}}" title="{{this.title}}">
{{#if this.steps}}
{{#each this.steps}}
      <step zero_based_index="{{@index}}">
        <action>{{this.action}}</action>
        <expected_result>{{this.expectedResult}}</expected_result>
      </step>
{{/each}}
{{/if}}
    </test_case>
{{/each}}
  </test_cases>
{{/if}}
</work_item>

{{/each}}
For each work item, produce a recap with:
- MATCH: requirements that are correctly implemented
- MISMATCH: requirements that are missing or incorrectly implemented
- NOT TESTED: test cases that could not be verified

End with the following summary tables:

**Results per User Story:**
| Work Item | Title | Status | Mismatches |
|-----------|-------|--------|------------|
(one row per work item — Status is ✅ PASS, ⚠️ PARTIAL, or ❌ FAIL)

{{#if (any workItems "testCases")}}
**Results per Test Case:**
| Work Item | Test Case | Spec Source | Expected Behavior | Actual Behavior | Status |
|-----------|-----------|-------------|-------------------|-----------------|--------|

Rules for this table:
- One row per test case (not per work item). Never merge or skip rows.
- **Spec Source**: where the expectation comes from. Quote the origin verbatim (trimmed to the relevant sentence), and name the artifact it came from, e.g. \`Test case #42, step 2: "Click Save"\` or \`Work item #17 description: "the badge must disappear once read"\`. Step numbers are 1-based for humans, so cite \`zero_based_index + 1\`. If the expectation is implied rather than written, mark it \`inferred from <artifact>\` and state what was inferred and why.
- **Expected Behavior**: 2-4 sentences, not a fragment. Spell out the precondition / setup, the exact user action, the observable outcome (what appears, changes, is persisted, is emitted), and any edge condition or state transition the spec requires. Name concrete UI labels, fields, statuses, values, and side effects rather than saying "works correctly" or "behaves as expected".
- **Actual Behavior**: what the current code actually does, with the file + function/symbol that implements (or fails to implement) it. On FAIL, state the concrete gap and where to fix it. On NOT TESTED, state precisely what blocked verification and what is needed (running app, credentials, device, data fixture...).
- **Status**: ✅ PASS, ❌ FAIL, or ⬚ NOT TESTED — no ⚠️ PARTIAL in this table; a partially satisfied test case is ❌ FAIL.

Formatting rules so the table stays valid: escape every \`|\` inside a cell as \`\\|\`, strip any HTML tags coming from work item descriptions and keep only their text, and never emit a raw newline inside a cell — use \`<br>\` instead. If a cell gets long, break it with \`<br>\` rather than shortening the explanation.
{{/if}}`,
    enabled: true,
    contexts: { newTask: true, newTaskStep: true },
    autocomplete: { enabled: false, slugs: [] },
  },
  {
    id: 'builtin-update-branch',
    name: 'update-branch',
    description: 'Merge source branch into this branch and resolve conflicts',
    template: `merge "{{task.sourceBranch}}" (most up to date between local and remote) into this branch and resolve conflicts

fix all tests/lint/type check (even issues that is not from our changes)

when you resolved conflicts, give a concise summary of what conflicted and what you did to resolve it

i might have done some changes, so don't try to roll them back
in case of doubt, ask first`,
    enabled: true,
    contexts: { newTask: true, newTaskStep: true },
    autocomplete: { enabled: true, slugs: ['update-branch'] },
  },
  {
    id: 'builtin-update-tests',
    name: 'update tests',
    description: 'updates tests after i made some additional changes',
    template: `I made some additional changes, please update tests accordingly
only update tests, don't rollback my changes
You have some doubt on some part of my changes, ask first`,
    enabled: true,
    contexts: { newTask: true, newTaskStep: true },
    autocomplete: { enabled: true, slugs: ['update-tests'] },
  },
];

export const BUILTIN_SNIPPET_IDS = new Set(BUILTIN_SNIPPETS.map((s) => s.id));

export function isBuiltinSnippet(id: string): boolean {
  return BUILTIN_SNIPPET_IDS.has(id);
}
