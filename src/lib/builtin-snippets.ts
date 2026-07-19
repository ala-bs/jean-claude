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
      <step>
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
| Work Item | Test Case | Status | Notes |
|-----------|-----------|--------|-------|
(one row per test case — Status is ✅ PASS, ❌ FAIL, or ⬚ NOT TESTED. Notes = brief reason when not PASS)
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
In case of doubt ask me first`,
    enabled: true,
    contexts: { newTask: true, newTaskStep: true },
    autocomplete: { enabled: true, slugs: ['update-tests'] },
  },
];

export const BUILTIN_SNIPPET_IDS = new Set(BUILTIN_SNIPPETS.map((s) => s.id));

export function isBuiltinSnippet(id: string): boolean {
  return BUILTIN_SNIPPET_IDS.has(id);
}
