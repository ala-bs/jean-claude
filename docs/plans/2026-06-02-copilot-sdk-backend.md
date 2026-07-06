# Copilot SDK Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GitHub Copilot SDK as third Jean-Claude agent backend using user Copilot subscription when available.

**Architecture:** Implement `copilot` as another `AgentBackend` adapter in Electron main process. The adapter wraps `@github/copilot-sdk` sessions, maps SDK events into Jean-Claude normalized events, and reuses existing task/session/permission orchestration in `agent-service`.

**Tech Stack:** Electron main process, TypeScript, `@github/copilot-sdk`, Vitest, React settings/backend selectors.

---

## Scope

Build backend support in three increments:

1. **MVP:** backend type, settings/UI availability, simple Copilot session, streaming text normalization, stop/dispose, basic model list.
2. **Agent Tools:** permission requests, file/shell/tool event normalization, user questions, attachments, session resume.
3. **Polish:** auth diagnostics, summary support, model capabilities, settings copy, tests, docs.

Do **not** add changelog entries unless explicitly requested.

## Key Decisions

- Use SDK package `@github/copilot-sdk`.
- Prefer `useLoggedInUser: true` for MVP so installed Copilot CLI/user credentials can be reused.
- Do not add GitHub OAuth app flow in MVP.
- Do not add BYOK UI in MVP; SDK BYOK can be future work.
- Keep `AgentBackendType` value `copilot`.
- Keep Copilot skills/custom agents out of MVP. Jean-Claude skills can be appended as prompt context later if needed.
- Treat `ask`, `auto`, and `plan` like current backend modes, but map `plan` through extra system/prompt instruction unless SDK has first-class mode support.

## References

- Copilot SDK package: `@github/copilot-sdk`
- Copilot SDK README: https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/README.md
- Existing backend abstraction: `shared/agent-backend-types.ts`
- Backend factory: `electron/services/agent-backends/index.ts`
- Claude adapter example: `electron/services/agent-backends/claude/claude-code-backend.ts`
- OpenCode adapter example: `electron/services/agent-backends/opencode/opencode-backend.ts`
- Dynamic model service: `electron/services/backend-models-service.ts`

---

### Task 1: Add SDK Dependency

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Install package**

Run:

```bash
pnpm add @github/copilot-sdk
```

Expected: package added to dependencies and lockfile updated.

**Step 2: Verify install**

Run:

```bash
pnpm install
```

Expected: install completes and `electron-rebuild` runs.

**Step 3: Inspect exported types**

Run:

```bash
node -e "import('@github/copilot-sdk').then(m => console.log(Object.keys(m).sort()))"
```

Expected: output includes `CopilotClient`. Note exact permission/model type names for later tasks.

---

### Task 2: Add Backend Type And Settings Validation

**Files:**

- Modify: `shared/agent-backend-types.ts`
- Modify: `shared/types.ts`
- Modify: `shared/thinking-settings.ts`
- Test: `shared/thinking-settings.test.ts`

**Step 1: Write failing settings/thinking tests**

In `shared/thinking-settings.test.ts`, add coverage that `copilot` returns default effort options and accepts model-specific capabilities:

```ts
it('returns default thinking option for copilot without model capabilities', () => {
  expect(
    getThinkingEffortOptions({
      backend: 'copilot',
      model: 'default',
    }).map((option) => option.value),
  ).toEqual(['default']);
});

it('normalizes unsupported copilot thinking effort to default', () => {
  expect(
    normalizeThinkingEffortForModel({
      backend: 'copilot',
      model: 'default',
      effort: 'high',
    }),
  ).toBe('default');
});
```

**Step 2: Run test to verify fail**

Run:

```bash
pnpm test shared/thinking-settings.test.ts
```

Expected: TypeScript compile/test fails because `copilot` is not assignable to `AgentBackendType`.

**Step 3: Add type and settings defaults**

Make these changes:

```ts
// shared/agent-backend-types.ts
export type AgentBackendType = 'claude-code' | 'opencode' | 'copilot';
```

In `shared/types.ts`:

```ts
const VALID_BACKENDS: AgentBackendType[] = [
  'claude-code',
  'opencode',
  'copilot',
];
```

Add Copilot interaction options. Start with same labels as OpenCode:

```ts
export const COPILOT_INTERACTION_MODE_OPTIONS =
  OPENCODE_INTERACTION_MODE_OPTIONS;

export const BACKEND_INTERACTION_MODE_OPTIONS: Record<
  AgentBackendType,
  readonly BackendInteractionModeOption[]
> = {
  'claude-code': CLAUDE_CODE_INTERACTION_MODE_OPTIONS,
  opencode: OPENCODE_INTERACTION_MODE_OPTIONS,
  copilot: COPILOT_INTERACTION_MODE_OPTIONS,
};
```

Add defaults:

```ts
summaryModels: {
  defaultValue: {
    models: {
      'claude-code': 'haiku',
      opencode: 'default',
      copilot: 'default',
    },
  } as SummaryModelsSetting,
  validate: isSummaryModelsSetting,
},
thinkingSettings: {
  defaultValue: {
    efforts: {
      'claude-code': { default: 'default' },
      opencode: { default: 'default' },
      copilot: { default: 'default' },
    },
  } as ThinkingSettingsSetting,
  validate: isThinkingSettingsSetting,
},
```

In `shared/thinking-settings.ts`, keep fallback behavior for `copilot` as default-only for now. No custom branch required unless dynamic model capabilities become reliable.

**Step 4: Run tests**

Run:

```bash
pnpm test shared/thinking-settings.test.ts
```

Expected: pass.

---

### Task 3: Add Copilot To Backend Selector UI

**Files:**

- Modify: `src/features/agent/ui-backend-selector/index.tsx`
- Modify: `src/features/settings/ui-general-settings/index.tsx`

**Step 1: Add backend option**

In `AVAILABLE_BACKENDS`, append:

```ts
{
  value: 'copilot',
  label: 'Copilot',
  description: 'GitHub Copilot SDK',
},
```

**Step 2: Update settings merge objects**

In `src/features/settings/ui-general-settings/index.tsx`, update any hard-coded settings merges for `summaryModels` and `thinkingSettings` to include `copilot: 'default'` and `copilot: { default: 'default' }`.

**Step 3: Search for remaining hard-coded backend lists**

Run:

```bash
rg "claude-code.*opencode|opencode.*claude-code|VALID_BACKENDS|enabledBackends|summaryModels|thinkingSettings" src shared electron -g '*.ts' -g '*.tsx'
```

Expected: inspect hits and update only hard-coded backend settings that would reject/drop Copilot.

**Step 4: Type-check UI changes**

Run:

```bash
pnpm ts-check
```

Expected: no `copilot` missing property errors.

---

### Task 4: Add Copilot Backend Skeleton

**Files:**

- Create: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Create: `electron/services/agent-backends/copilot/normalize-copilot-message-v2.ts`
- Modify: `electron/services/agent-backends/index.ts`
- Test: `electron/services/agent-backends/copilot/normalize-copilot-message-v2.test.ts`

**Step 1: Write normalizer tests first**

Create tests that define minimal event shapes from SDK README:

```ts
import { describe, expect, it } from 'vitest';

import { normalizeCopilotEventV2 } from './normalize-copilot-message-v2';

describe('normalizeCopilotEventV2', () => {
  it('normalizes assistant.message into assistant text entry', () => {
    const events = normalizeCopilotEventV2({
      type: 'assistant.message',
      data: { content: 'Hello from Copilot' },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'entry',
        role: 'assistant',
      }),
    ]);
    expect(JSON.stringify(events)).toContain('Hello from Copilot');
  });

  it('normalizes session.idle into result event', () => {
    expect(normalizeCopilotEventV2({ type: 'session.idle', data: {} })).toEqual(
      [expect.objectContaining({ type: 'result' })],
    );
  });
});
```

**Step 2: Run test to verify fail**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/normalize-copilot-message-v2.test.ts
```

Expected: fail because files do not exist.

**Step 3: Implement minimal normalizer**

Use `shared/normalized-message-v2.ts` as source of exact normalized entry shape. Mirror Claude/OpenCode style, but start minimal:

- `assistant.message` -> assistant text entry.
- `assistant.message_delta` -> assistant text delta entry if app supports deltas; otherwise ignore in MVP and rely on final message.
- `assistant.reasoning` -> reasoning/thinking entry if existing schema supports it; otherwise assistant text entry with metadata.
- `session.idle` -> `result` event.
- Unknown event -> no events.

Keep raw event persisted by backend even if normalizer ignores it.

**Step 4: Implement skeleton backend**

Create `CopilotBackend` with same public methods as `AgentBackend`:

- Constructor saves `AgentTaskContext`.
- `start()` creates session key, starts `CopilotClient`, creates SDK session, sends prompt, returns async event channel.
- `stop()` aborts SDK session and closes channel.
- `dispose()` stops all clients.
- `respondToPermission()`, `respondToQuestion()`, `setMode()` are no-op or throw only if pending maps require them later.
- `summarizeSession()` returns fallback summary using a temporary Copilot session or throws with clear message until Task 10.

Use `getPromptText(parts)` and file/image attachment mapping from prompt utils. Start with text-only if attachment type names need SDK type confirmation.

**Step 5: Register backend**

In `electron/services/agent-backends/index.ts`:

```ts
import { CopilotBackend } from './copilot/copilot-backend';

export const AGENT_BACKEND_CLASSES: Record<
  AgentBackendType,
  AgentBackendClass
> = {
  'claude-code': ClaudeCodeBackend,
  opencode: OpenCodeBackend,
  copilot: CopilotBackend,
};
```

**Step 6: Run normalizer test**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/normalize-copilot-message-v2.test.ts
```

Expected: pass.

---

### Task 5: Implement Copilot Runtime Session Flow

**Files:**

- Modify: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Test: `electron/services/agent-backends/copilot/copilot-backend.test.ts`

**Step 1: Write backend tests with mocked SDK**

Mock `@github/copilot-sdk` to avoid real Copilot auth in unit tests. Test:

- `start()` calls `new CopilotClient({ workingDirectory: cwd, useLoggedInUser: true })`.
- `start()` calls `client.start()`.
- `start()` calls `client.createSession({ model })` when model is not `default`.
- `start()` calls `session.send({ prompt })`.
- SDK `assistant.message` event yields Jean-Claude `entry` event with persisted raw id.
- `stop()` calls `session.abort()` and `session.disconnect()`.

**Step 2: Run test to verify fail**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: fail until backend complete.

**Step 3: Implement session state**

Backend state should track:

```ts
interface CopilotSessionState {
  sessionId: string;
  client: CopilotClient;
  sdkSession: CopilotSession;
  eventChannel: AsyncEventChannel<AgentEvent>;
  unsubscribers: Array<() => void>;
  messageIndex: number;
  cwd: string;
}
```

Use an `AsyncEventChannel` same as Claude/OpenCode. If duplication bothers lint, keep local copy for MVP; refactor later only if needed.

**Step 4: Persist raw events**

For each SDK event:

1. Call `taskContext.persistRaw({ messageIndex, backendSessionId: sdkSession.sessionId, rawData: event })`.
2. Increment `messageIndex`.
3. Normalize event.
4. Push each normalized event as `AgentEvent`, adding `rawMessageId` to entries.

**Step 5: Map prompt parts**

Implement:

- Text parts join into prompt text.
- File parts map to SDK file attachments: `{ type: 'file', path: part.filePath, displayName: part.filename }`.
- Image parts map to SDK blob attachments: `{ type: 'blob', data: part.data, mimeType: part.mimeType }`.

If SDK type import disagrees, adapt to actual exported `MessageOptions` attachment shape.

**Step 6: Run backend tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: pass.

---

### Task 6: Add Model Discovery

**Files:**

- Modify: `electron/services/backend-models-service.ts`
- Test: `electron/services/backend-models-service.test.ts` or existing model service test file if present

**Step 1: Add tests**

Test `getBackendModels('copilot')` returns at least static fallback when SDK/runtime unavailable.

Expected fallback models:

```ts
const COPILOT_FALLBACK_MODELS: BackendModel[] = [
  {
    id: 'gpt-5',
    label: 'GPT-5',
    supportsThinking: true,
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    supportsThinking: true,
    thinkingEfforts: ['low', 'medium', 'high'],
  },
];
```

**Step 2: Implement Copilot model fetching**

Options:

- Preferred: instantiate `CopilotClient`, `start()`, call SDK model-list method if exported, then `stop()`.
- Fallback: return static model list above.

Cache under `modelCache.set('copilot', ...)` with same TTL.

**Step 3: Run model tests**

Run:

```bash
pnpm test electron/services/backend-models-service.test.ts
```

Expected: pass. If no existing file, run new test path.

---

### Task 7: Add Permission Handling

**Files:**

- Modify: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Modify: `electron/services/agent-backends/copilot/normalize-copilot-message-v2.ts`
- Test: `electron/services/agent-backends/copilot/copilot-backend.test.ts`

**Step 1: Write permission tests**

Mock SDK `onPermissionRequest` callback and verify:

- Auto-approved existing permission rules return SDK approval.
- Ask-mode pushes Jean-Claude `permission` event.
- `respondToPermission(... allow ...)` resolves SDK permission request as approve-once.
- `respondToPermission(... deny ...)` resolves SDK permission request as reject.

**Step 2: Map Copilot permission request to Jean-Claude permission request**

Copilot SDK request fields from README:

- `kind`: `shell`, `write`, `read`, `mcp`, `custom-tool`, `url`, `memory`, `hook`.
- `toolName`
- `fileName`
- `fullCommandText`
- `toolCallId`

Convert to existing permission system input:

- `shell` -> tool `Bash`, command pattern from `fullCommandText`.
- `write` -> tool `Write` or `Edit`, path from `fileName`.
- `read` -> tool `Read`, path from `fileName`.
- `mcp` -> tool name from `toolName`.
- unknown -> tool `copilot:<kind>` with raw args.

Use existing helpers in `permission-settings-service`:

- `normalizeToolRequest`
- `evaluatePermission`

**Step 3: Map Jean-Claude response back to SDK decision**

Use actual SDK type names from Task 1. Expected shapes from README:

- allow once: `{ kind: 'approve-once' }`
- allow session: `{ kind: 'approve-for-session' }`
- deny: `{ kind: 'reject', feedback: response.message }`

If existing Jean-Claude permission scope includes project/worktree, map to closest SDK-supported decision and keep Jean-Claude persistence handled in `agent-service`.

**Step 4: Run permission tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: pass.

---

### Task 8: Add User Question Handling

**Files:**

- Modify: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Test: `electron/services/agent-backends/copilot/copilot-backend.test.ts`

**Step 1: Write tests for `onUserInputRequest`**

Mock SDK request:

```ts
{
  question: 'Which branch?',
  choices: ['main', 'dev'],
  allowFreeform: true,
}
```

Expected: backend emits Jean-Claude `question` event.

**Step 2: Implement pending question map**

Store resolver by generated request id. Convert Jean-Claude answer record into SDK response:

```ts
{
  answer: Object.values(answer).join('\n'),
  wasFreeform: true,
}
```

For choices, preserve selected labels. If multi-question UI sends multiple fields, join with labels.

**Step 3: Run tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: pass.

---

### Task 9: Add Session Resume

**Files:**

- Modify: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Test: `electron/services/agent-backends/copilot/copilot-backend.test.ts`

**Step 1: Write tests**

Verify:

- `config.sessionId` calls `client.resumeSession(config.sessionId, ...)`.
- No `config.sessionId` calls `client.createSession(...)`.
- Returned Jean-Claude session key differs from SDK persistent session id, and `session-id` normalized event emits SDK session id if schema supports it.

**Step 2: Implement resume path**

Use SDK README:

```ts
const sdkSession = config.sessionId
  ? await client.resumeSession(config.sessionId, sessionConfig)
  : await client.createSession(sessionConfig);
```

Attach same permission/question handlers for create and resume.

**Step 3: Run tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: pass.

---

### Task 10: Implement Session Summary

**Files:**

- Modify: `electron/services/agent-backends/copilot/copilot-backend.ts`
- Test: `electron/services/agent-backends/copilot/copilot-backend.test.ts`

**Step 1: Write summary test**

Mock temporary SDK session and verify `summarizeSession()` sends `SESSION_SUMMARY_PROMPT` plus session id/context and returns final assistant content.

**Step 2: Implement summary**

Use:

- `new CopilotClient({ workingDirectory: cwd, useLoggedInUser: true })`
- `client.start()`
- `client.createSession({ model })`
- `session.sendAndWait({ prompt: SESSION_SUMMARY_PROMPT ... })`
- return assistant content or `''`.
- cleanup with `disconnect()` and `client.stop()` in `finally`.

If Copilot SDK cannot access prior session transcript by id in prompt, summarize by asking Copilot to summarize its current session context only. If this is ineffective, document as limitation and return a clear fallback; do not block MVP.

**Step 3: Run tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/copilot-backend.test.ts
```

Expected: pass.

---

### Task 11: Auth Diagnostics And Settings Copy

**Files:**

- Modify: `src/features/settings/ui-general-settings/index.tsx`
- Modify: `electron/services/backend-models-service.ts`
- Optional Create: `electron/services/copilot-auth-service.ts`

**Step 1: Add user-facing copy**

In backend settings area, show Copilot description:

```text
Uses GitHub Copilot SDK. Requires Copilot CLI login or a GitHub token with Copilot access. Usage counts against Copilot premium requests.
```

Keep UI minimal. Do not add OAuth/token fields yet.

**Step 2: Add failure message for model discovery**

When Copilot model discovery fails, return fallback list but log diagnostic:

```ts
dbg.agent('Failed to fetch Copilot models; using fallback models: %O', error);
```

If settings UI already surfaces model fetch failure, keep fallback silent enough that task creation remains possible.

**Step 3: Optional CLI/auth probe**

If SDK exposes a cheap `ping()`/auth check, add service method later. Do not add IPC in MVP unless UI needs it.

---

### Task 12: Integration Smoke Test

**Files:**

- No code unless failures found.

**Step 1: Run required install**

Run:

```bash
pnpm install
```

Expected: dependencies installed.

**Step 2: Run focused tests**

Run:

```bash
pnpm test electron/services/agent-backends/copilot/normalize-copilot-message-v2.test.ts electron/services/agent-backends/copilot/copilot-backend.test.ts shared/thinking-settings.test.ts
```

Expected: pass.

**Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: pass.

**Step 4: Run lint fix**

Run:

```bash
pnpm lint --fix
```

Expected: auto-fixes formatting/lint issues.

**Step 5: Run TypeScript check**

Run:

```bash
pnpm ts-check
```

Expected: pass.

**Step 6: Run final lint**

Run:

```bash
pnpm lint
```

Expected: pass.

---

## Manual QA

Use only after automated checks pass.

1. Ensure local GitHub Copilot CLI/user auth works.
2. Launch app with dev script only if needed for manual verification.
3. Enable Copilot backend in Settings > General.
4. Create new task with backend Copilot and model Default.
5. Prompt: `Say hello, then list current directory without modifying files.`
6. Confirm streaming/final assistant message appears.
7. Prompt command requiring permission: `Create a file named copilot-smoke-test.txt with one line.`
8. Confirm permission UI appears in ask mode.
9. Deny once; verify agent receives denial.
10. Repeat and allow once; verify file edit/tool output normalizes.
11. Stop an active Copilot run; verify session stops and UI no longer hangs.
12. Resume task step; verify prompt continues same SDK session if supported.

## Risks

- SDK API is beta-ish in npm metadata and may shift; pin exact version and mock tests around observed exports.
- Copilot SDK may emit event shapes not documented in README; keep raw persistence and add normalizer tests from real captured events.
- Copilot session summary may not support summarizing arbitrary prior session by id; can be fallback-only until SDK exposes transcript APIs.
- Permission mapping may be lossy for URL/memory/hook kinds; prefer deny/ask over silent allow.
- Copilot CLI login availability differs from GitHub OAuth token flow; MVP should clearly state requirement.

## Future Work

- GitHub OAuth/token UI for Copilot SDK auth.
- BYOK provider settings using SDK custom provider config.
- Copilot custom agents/skills integration.
- Remote session support if useful.
- Usage/quota display for Copilot premium requests if SDK exposes it.
