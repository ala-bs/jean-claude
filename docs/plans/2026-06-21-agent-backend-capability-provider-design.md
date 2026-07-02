# Agent Backend Capability Provider Design

## Goal

Make agent backends easier to understand, extend, and validate by replacing the current mostly-runner-oriented `AgentBackend` abstraction with an explicit backend provider contract.

The new contract should make every backend state, at compile time, whether it supports each app capability. It should also keep backend-specific mappings and behavior visible instead of hiding them behind broad optional methods or backend-id switches.

## Current Problems

- `AgentBackend` mixes session running, permission handling, questions, mode switching, raw message persistence, and backend lifecycle.
- Unsupported behavior is often represented by no-op methods, for example Codex currently implements empty permission/question/mode methods.
- Backend-specific behavior leaks into app services through backend-id checks, for example OpenCode synthetic user prompt handling and `ai-generation-service` switch statements.
- Capabilities outside task execution are scattered: model discovery, backend config, skills, agents, commands, and generation are not part of one coherent backend surface.
- AI generation is parallel to agent backends even though it uses the same backend ids, models, thinking effort, skill prompting, and usage tracking.

## Design Principles

- Every capability is explicitly declared as supported or unsupported.
- Unsupported capabilities include a reason string useful for logs and UI.
- Backend-specific mappings are first-class and testable.
- App orchestration asks for capabilities, not backend ids.
- One backend provider owns all backend-specific integration surfaces.
- Refactor incrementally with compatibility wrappers so the app can migrate safely.

## Provider Contract

Introduce a provider registry separate from the runnable session implementation:

```ts
export type Capability<T> =
  | { supported: true; implementation: T }
  | { supported: false; reason: string };

export interface AgentBackendProvider {
  id: AgentBackendType;
  label: string;
  description?: string;
  capabilities: AgentBackendCapabilities;
}
```

All providers must fill the full `AgentBackendCapabilities` object. This keeps omissions visible during backend integration.

```ts
export interface AgentBackendCapabilities {
  agent: {
    run: Capability<RunAgentCapability>;
    resume: Capability<ResumeSessionCapability>;
    permissions: Capability<PermissionCapability>;
    questions: Capability<QuestionCapability>;
    runtimeModeSwitch: Capability<RuntimeModeSwitchCapability>;
    sessionAllowedTools: Capability<SessionAllowedToolsCapability>;
    resourceTracking: Capability<ResourceTrackingCapability>;
  };
  generation: {
    text: Capability<TextGenerationCapability>;
    structured: Capability<StructuredGenerationCapability>;
  };
  configuration: {
    models: Capability<ModelDiscoveryCapability>;
    nativeConfig: Capability<BackendConfigCapability>;
  };
  resources: {
    skills: Capability<BackendSkillCapability>;
    agents: Capability<BackendAgentCapability>;
    slashCommands: Capability<SlashCommandCapability>;
    mcp: Capability<McpCapability>;
  };
  input: {
    text: Capability<PromptInputCapability>;
    images: Capability<PromptInputCapability>;
    files: Capability<PromptInputCapability>;
  };
}
```

This is intentionally exhaustive but grouped by domain to avoid a flat noisy manifest. If a fourth backend is added, TypeScript should force a decision for each capability.

Static support is not enough for all cases. Some support depends on runtime input, model, project config, or transport mode. Each supported capability can optionally expose validation:

```ts
export type CapabilityValidation =
  | { ok: true }
  | { ok: false; reason: string; severity: 'error' | 'warning' };

export interface ValidatedCapability<Input> {
  validate?(input: Input): Promise<CapabilityValidation> | CapabilityValidation;
}
```

Examples:

- OpenCode runtime MCP may require a dedicated server.
- prompt files may be unsupported even if text/images are supported.
- image support may depend on selected model.
- resume may fail closed when backend session id no longer exists.

## Capability Shape

Use small capability interfaces rather than one large backend class.

```ts
export interface RunAgentCapability {
  start(input: AgentRunInput): Promise<AgentRunHandle>;
}

export interface PermissionCapability {
  respond(input: PermissionResponseInput): Promise<void>;
}

export interface TextGenerationCapability {
  generate(input: TextGenerationInput): Promise<TextGenerationResult>;
}

export interface StructuredGenerationCapability {
  generate(input: StructuredGenerationInput): Promise<StructuredGenerationResult>;
  mode: 'native-schema' | 'prompt-json' | 'tool-call' | 'custom';
}

export interface SlashCommandCapability {
  list(input: { cwd?: string }): Promise<BackendSlashCommand[]>;
}
```

`AgentRunInput` must include the existing per-task persistence context explicitly:

```ts
export interface AgentRunInput {
  config: AgentBackendConfig;
  parts: PromptPart[];
  context: AgentTaskContext;
}
```

The returned run handle owns lifecycle and process metadata. This avoids splitting start/stop state across provider and `agent-service`.

```ts
export interface AgentRunHandle {
  runId: string;
  backendSessionId: string | null;
  events: AsyncIterable<AgentEvent>;
  rootPid?: number;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
```

The handle is responsible for startup cleanup, stop races, abort/interrupt behavior, and backend resource release. OpenCode can hide shared/dedicated server ownership inside this handle; Codex can hide thread/turn interrupt semantics.

`agent-service` should keep one active backend run, but its operations should call capability implementations:

```ts
const run = await requireCapability(provider.capabilities.agent.run).start(input);

if (provider.capabilities.agent.permissions.supported) {
  await provider.capabilities.agent.permissions.implementation.respond(input);
}
```

`requireCapability()` throws a typed unsupported-capability error with backend id, capability name, and reason.

## Backend Mappings

Provider implementations own mappings from Jean-Claude concepts into backend-native concepts. These mappings should not return `unknown` to app services.

```ts
export interface AgentBackendMappings {
  // Backend-local type, not exported through the generic provider registry.
  // Example: ClaudeCodeMappings returns Claude SDK options.
  // Example: OpenCodeMappings returns OpenCode session prompt arguments.
}
```

Claude can map `auto` to `bypassPermissions`; OpenCode can map thinking effort to variants; Codex can map prompts to thread/turn input. Those mappings should be strongly typed inside each provider module and covered by provider tests. The generic app layer should only pass normalized input and receive normalized output.

This keeps compile-time checking where it matters without forcing native SDK option types into shared code.

## Resume Semantics

Resume is declared as a capability but executed through `agent.run.start()`.

`AgentRunInput.config.sessionId` remains the normalized resume id. Provider behavior must be explicit:

- supported resume: attempt backend-native resume and emit `session-id` for the durable backend id
- missing/invalid session: fail closed with typed backend error unless provider documents a safe fallback
- unsupported resume: reject before start through capability validation

This matches current backend differences: Codex uses thread resume, OpenCode has strict session behavior, and Claude resumes through SDK session id.

## AI Generation Integration

Move `generateText()` behind provider capabilities.

Current callers can keep calling `generateText()` during migration, but the function should become a thin registry lookup:

```ts
export async function generateText(input: GenerateTextInput) {
  const provider = getAgentBackendProvider(input.backend);
  const capability = input.outputSchema
    ? requireCapability(provider.capabilities.generation.structured)
    : requireCapability(provider.capabilities.generation.text);
  return capability.generate(input);
}
```

Backend support becomes explicit:

| Backend | Text Generation | Structured Generation |
|---|---|---|
| Claude Code | supported | supported, native schema |
| OpenCode | supported | supported, SDK format plus JSON fallback |
| Codex | unsupported initially | unsupported initially |

This removes silent `null` from the provider layer for unsupported Codex generation. The compatibility wrapper can temporarily preserve current `generateText()` behavior:

- unsupported/error/timeout returns `null` when `throwOnError` is false
- unsupported/error/timeout throws when `throwOnError` is true
- required generation call sites, such as PR description and merge commit message, keep their current failure behavior
- optional generation call sites, such as task name or project summary fallback, keep current null/fallback behavior

Phase 2 should audit call sites before changing user-visible failure semantics.

Usage tracking should stay centralized. Generation capabilities return usage metadata; a shared wrapper records usage:

```ts
type GenerationResult = {
  output: unknown | null;
  usage?: TokenUsage;
  cost?: CostInfo;
  actualModel?: string;
  sourceId?: string | null;
};
```

## Resource Capabilities

Skills, agents, and commands should become provider capabilities instead of separate backend switches.

```ts
export interface BackendResourceIdentity {
  id: string;
  name: string;
  scope: 'user' | 'project' | 'plugin' | 'builtin' | 'source';
  canonicalPath?: string;
  backendPath?: string;
  editable: boolean;
  source?: 'filesystem' | 'symlink' | 'backend-api' | 'plugin' | 'github-source';
}

export interface BackendSkillCapability {
  list(input: { cwd?: string; scope?: string }): Promise<BackendResourceIdentity[]>;
  enable(input: { canonicalPath: string; cwd?: string }): Promise<void>;
  disable(input: { canonicalPath: string; cwd?: string }): Promise<void>;
  install?(input: ResourceInstallInput): Promise<BackendResourceIdentity>;
}

export interface BackendAgentCapability {
  list(input: { cwd?: string; scope?: string }): Promise<BackendResourceIdentity[]>;
  enable(input: { canonicalPath: string; cwd?: string }): Promise<void>;
  disable(input: { canonicalPath: string; cwd?: string }): Promise<void>;
  install?(input: ResourceInstallInput): Promise<BackendResourceIdentity>;
}

export interface BackendSlashCommand {
  id: string;
  label: string;
  description?: string;
  source: 'builtin' | 'user' | 'backend';
  backendOnly?: boolean;
}
```

Examples:

- Codex exposes `/goal` through `slashCommands`.
- Claude can expose slash commands as unsupported if not available through SDK.
- Existing filesystem skill/agent support can remain supported for Claude/OpenCode and Codex only where the app server exposes it.
- Skill and agent providers must preserve current safety boundaries: canonical Jean-Claude storage, backend-specific target paths, symlink ownership checks, project/user/plugin/source scopes, and allowed roots.

UI can query provider capability state to show unavailable panels with clear reasons instead of hardcoded backend exclusions.

## Provider Registry

Replace `AGENT_BACKEND_CLASSES` with a provider registry.

```ts
export const AGENT_BACKEND_PROVIDERS = {
  'claude-code': claudeCodeProvider,
  opencode: openCodeProvider,
  codex: codexProvider,
} satisfies Record<AgentBackendType, AgentBackendProvider>;
```

Each provider owns:

- run implementation
- mappings
- generation implementation
- model discovery
- native backend config read/write
- skills/agents support
- slash commands
- lifecycle helpers, such as shared OpenCode server or Codex app server

Legacy backend classes can remain internally during migration, but should no longer be the top-level abstraction.

Provider boundaries:

- app settings remain app settings
- project settings remain project settings
- backend-native config files, for example Claude/OpenCode/Codex config, belong to `configuration.nativeConfig`
- model caches stay shared unless backend SDK requires provider-local caching

## Agent Service Changes

`agent-service` should become capability-driven:

- resolve provider from selected backend
- call `provider.capabilities.agent.run.start()` instead of `backend.start()`
- call permission/question/mode only when capability is supported
- use provider mappings before run start
- remove backend-id checks where possible
- move OpenCode synthetic prompt behavior into provider capability or normalized event behavior

Active session state should store `providerId` and `runId`, not assume all session operations exist.

## Error Handling

Add a typed unsupported error:

```ts
export class UnsupportedBackendCapabilityError extends Error {
  constructor(input: {
    backend: AgentBackendType;
    capability: keyof AgentBackendCapabilities;
    reason: string;
  });
}
```

Rules:

- user-triggered unsupported action: return actionable UI error
- background optional feature: log and skip
- configured required feature, for example PR description generation: throw, so caller can surface failure
- migration wrappers may preserve current `null` behavior temporarily, but provider capabilities should not silently ignore unsupported operations

## Testing

Add contract tests:

- every `AgentBackendType` has a provider
- every provider declares every capability
- unsupported capabilities have non-empty reasons
- supported capabilities expose required functions
- provider-local mapping tests cover model, thinking effort, interaction mode, permission rules, and prompt parts

Add service tests:

- `generateText()` routes through provider generation capability
- Codex generation unsupported throws typed error when `throwOnError` is true
- `agent-service` does not call permission/question/mode when capability unsupported
- UI-facing capability summaries derive from provider registry

Add provider tests:

- Claude generation preserves native schema output
- OpenCode structured generation preserves SDK structured result and JSON fallback
- Codex command list includes backend-specific commands when supported
- model discovery uses provider capability instead of backend switch

## Migration Plan

### Phase 1: Types And Registry

- Add provider contract and capability types.
- Add providers for Claude Code, OpenCode, Codex.
- Keep current `AgentBackend` classes behind `agent.run` during migration.
- Add contract tests.

### Phase 2: AI Generation

- Move Claude/OpenCode generation implementations into provider capabilities.
- Keep `generateText()` as compatibility wrapper.
- Represent Codex generation as unsupported with reason.
- Return usage metadata from capability and keep shared usage recording.

### Phase 3: Agent Service

- Change `agent-service` to resolve provider.
- Route run/stop/permission/question/mode through capabilities.
- Remove no-op methods from Codex backend.
- Move backend-specific prompt/session behaviors behind provider implementation.

### Phase 4: Resources

- Move model discovery, backend config, skills, agents, commands, and MCP surfaces behind provider capabilities.
- Update settings/source UIs to read capability state.
- Add command list support for backend-native commands like Codex `/goal`.

### Phase 5: Cleanup

- Remove `AGENT_BACKEND_CLASSES`.
- Remove backend-id switches replaced by provider capabilities.
- Rename remaining runner types around `AgentRun` rather than `AgentBackend`.

## Open Decisions

- Whether structured generation should be one capability with `outputSchema` option or separate `textGeneration` and `structuredGeneration` capabilities. Recommendation: keep separate because fallback/error behavior differs.
- Whether unsupported optional features should be hidden or shown disabled in settings. Recommendation: show disabled with reason for settings and resource panels.
- Whether OpenCode synthetic user prompt should stay in `agent-service` until normalizer parity is complete. Recommendation: move it in Phase 3, not Phase 1.
