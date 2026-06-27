# Agent Backend Provider Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add the backend provider contract and registry while preserving current runtime behavior.

**Architecture:** Introduce provider/capability types beside the current `AgentBackend` interface. Add Claude Code, OpenCode, and Codex providers that wrap existing backend classes under `agent.run`. Keep existing `AGENT_BACKEND_CLASSES` and service call sites unchanged for now.

**Tech Stack:** TypeScript, Vitest, Electron main process services.

---

### Task 1: Provider Contract And Registry

**Files:**

- Create: `shared/agent-backend-provider-types.ts`
- Create: `electron/services/agent-backends/providers.ts`
- Create: `electron/services/agent-backends/providers.test.ts`

**Step 1: Write contract tests**

Create tests that assert:

- every `AgentBackendType` has a provider
- every provider declares all top-level capability groups
- every unsupported capability has non-empty `reason`
- every supported capability has an `implementation`
- `agent.run` is supported for all current backends

Run:

```bash
pnpm test electron/services/agent-backends/providers.test.ts
```

Expected: fail because files do not exist.

**Step 2: Add provider types**

Create `shared/agent-backend-provider-types.ts` with:

- `Capability<T>`
- `CapabilityValidation`
- `ValidatedCapability<Input>`
- `AgentRunInput`
- `AgentRunHandle`
- capability interfaces for agent, generation, configuration, resources, input
- `AgentBackendCapabilities`
- `AgentBackendProvider`
- `UnsupportedBackendCapabilityError`
- `requireCapability`

Keep types minimal and compatible with existing imports. Reuse existing `AgentBackendConfig`, `AgentTaskContext`, `AgentEvent`, `PromptPart`, `InteractionMode`, usage/cost types.

**Step 3: Add providers**

Create `electron/services/agent-backends/providers.ts`.

Implement:

- `createRunCapability(BackendClass)`
- `claudeCodeProvider`
- `openCodeProvider`
- `codexProvider`
- `AGENT_BACKEND_PROVIDERS`
- `getAgentBackendProvider(type)`

For `agent.run`, instantiate the existing backend class with `input.context`, call `backend.start(input.config, input.parts)`, and return an `AgentRunHandle` whose `stop()` and `dispose()` delegate to the backend.

Mark non-migrated capabilities unsupported with useful reasons. Mark known support conservatively:

- `agent.run`: supported for all three
- `agent.permissions`: supported for Claude Code and OpenCode, unsupported for Codex for now
- `agent.questions`: supported for Claude Code and OpenCode, unsupported for Codex for now
- `agent.runtimeModeSwitch`: supported for Claude Code, unsupported for OpenCode/Codex
- `agent.sessionAllowedTools`: supported for Claude Code, unsupported for OpenCode/Codex
- `agent.resume`: supported for all three
- `agent.resourceTracking`: supported for OpenCode/Codex root pid where available, supported as current service-level monitoring for Claude
- generation/configuration/resources/input: unsupported in provider Phase 1 unless implementation is already moved

Do not remove `AGENT_BACKEND_CLASSES`.

**Step 4: Verify targeted tests**

Run:

```bash
pnpm test electron/services/agent-backends/providers.test.ts
```

Expected: pass.

**Step 5: Verify types**

Run:

```bash
pnpm ts-check
```

Expected: pass.

**Step 6: No commit**

Leave changes uncommitted.

