# Agent Backend Provider Phase 3 Agent Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Migrate `agent-service` from direct `AgentBackend` class usage to provider `agent.*` capabilities without changing task behavior.

**Architecture:** Keep existing backend adapters and event normalization intact. `agent-service` resolves an `AgentBackendProvider`, starts runs through `provider.capabilities.agent.run`, stores the returned `AgentRunHandle`, and routes permission/question/mode/session-allowed-tools through provider capabilities. `AGENT_BACKEND_CLASSES` remains for legacy callers until cleanup.

**Tech Stack:** TypeScript, Vitest, Electron main process services, provider registry from Phase 1.

---

### Task 1: Agent Service Provider Runtime

**Files:**

- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/agent-service.test.ts`
- Modify if needed: `electron/services/agent-backends/providers.test.ts`

**Step 1: Add tests**

Extend `electron/services/agent-service.test.ts` or add focused tests that prove:

- `agent-service` no longer imports/uses `AGENT_BACKEND_CLASSES` directly for session creation.
- active run startup uses `provider.capabilities.agent.run.start()` with `AgentTaskContext`.
- stop uses `AgentRunHandle.stop()` even when stop races with startup.
- permission responses route through `provider.capabilities.agent.permissions`.
- question responses route through `provider.capabilities.agent.questions`.
- mode changes route through `provider.capabilities.agent.runtimeModeSwitch` only when supported.
- session allowed tools sync uses `provider.capabilities.agent.sessionAllowedTools` only when supported.

Use mocks for provider capabilities. Do not exercise real SDK backends.

Run targeted tests:

```bash
pnpm test electron/services/agent-service.test.ts electron/services/agent-backends/providers.test.ts
```

Expected: fail until migration is implemented.

**Step 2: Update ActiveSession**

In `electron/services/agent-service.ts`:

- remove `backend: AgentBackend`
- add `provider: AgentBackendProvider`
- add `runHandle: AgentRunHandle | null`
- change `backendStartPromise?: Promise<AgentSession>` to `runStartPromise?: Promise<AgentRunHandle>`

Keep existing `backendSessionId` field temporarily if useful for pending request guards, but it should mirror `runHandle.runId`, not durable SDK session id.

**Step 3: Create sessions through provider registry**

In `createSession()`:

- remove `AGENT_BACKEND_CLASSES` lookup and backend instantiation
- use `getAgentBackendProvider(backendType)`
- keep the existing `AgentTaskContext` object construction
- store context on the session if needed for `agent.run.start()`

Do not change raw persistence behavior.

**Step 4: Start backend through provider run capability**

In `runBackend()`:

- build existing `AgentBackendConfig` exactly as before
- call:

```ts
const runCapability = requireCapability(
  session.provider.id,
  'agent.run',
  session.provider.capabilities.agent.run,
);
session.runStartPromise = runCapability.start({
  context: session.agentTaskContext,
  config,
  parts: effectiveParts,
});
const runHandle = await session.runStartPromise;
session.runHandle = runHandle;
session.backendSessionId = runHandle.runId;
session.runStartPromise = undefined;
```

- use `runHandle.events` and `runHandle.rootPid`
- in `finally`, call `await runHandle.stop()`

Keep OpenCode synthetic prompt behavior in `agent-service` for now.

**Step 5: Stop through run handle**

In stop handling:

- abort controller as before
- if `session.runHandle` exists, call `session.runHandle.stop()`
- otherwise await `session.runStartPromise` and call `handle.stop()`
- keep resource monitor stop and synthetic stop entry behavior

Do not call backend adapter methods directly.

**Step 6: Route permission/question through capabilities**

In response handling:

- for permissions, require `session.provider.capabilities.agent.permissions`
- call `capability.respond({ handle: session.runHandle!, requestId, response })`
- for questions, require `session.provider.capabilities.agent.questions`
- if unsupported, surface existing error path rather than silently no-op

Preserve `toolsToAllow` computation.

**Step 7: Route mode changes through capabilities**

In `setMode()`:

- normalize mode as before
- if active session has a run handle and provider mode capability is supported, call it
- if unsupported, skip backend call and still persist normalized mode, matching current OpenCode/Codex no-op behavior

**Step 8: Route session allowed tools through capability**

In result handling:

- if active provider supports `agent.sessionAllowedTools` and has run handle, call capability
- preserve existing conversion of returned tool strings into `PermissionScope`

**Step 9: Verify targeted tests**

Run:

```bash
pnpm test electron/services/agent-service.test.ts electron/services/agent-backends/providers.test.ts
```

Expected: pass.

**Step 10: Verify types**

Run:

```bash
pnpm ts-check
```

Expected: pass.

**Step 11: No commit**

Leave changes uncommitted.

