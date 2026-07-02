# Agent Backend Provider Phase 2 AI Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Route AI text and structured generation through backend provider capabilities while preserving current `generateText()` behavior.

**Architecture:** Extract the existing Claude Code and OpenCode one-off generation implementations into provider generation capabilities. Keep `electron/services/ai-generation-service.ts` as a compatibility wrapper that creates an abort controller, resolves the selected provider, calls either `generation.text` or `generation.structured`, and preserves current timeout/error/null behavior.

**Tech Stack:** TypeScript, Vitest, Claude Agent SDK, OpenCode SDK, provider registry from Phase 1.

---

### Task 1: Provider Generation Capabilities

**Files:**

- Modify: `shared/agent-backend-provider-types.ts`
- Create: `electron/services/agent-backends/provider-generation.ts`
- Modify: `electron/services/agent-backends/providers.ts`
- Modify: `electron/services/ai-generation-service.ts`
- Modify: `electron/services/ai-generation-service.test.ts`
- Modify if needed: `electron/services/agent-backends/providers.test.ts`

**Step 1: Write/extend tests**

Extend `electron/services/ai-generation-service.test.ts` to assert:

- OpenCode structured output still returns native structured output
- OpenCode structured output still falls back to parsed JSON text
- OpenCode usage recording still works
- unsupported Codex generation returns `null` when `throwOnError` is false
- unsupported Codex generation throws when `throwOnError` is true

Extend provider tests if useful to assert:

- Claude Code provider supports `generation.text` and `generation.structured`
- OpenCode provider supports `generation.text` and `generation.structured`
- Codex provider does not support both generation capabilities and has reasons

Run:

```bash
pnpm test electron/services/ai-generation-service.test.ts electron/services/agent-backends/providers.test.ts
```

Expected: fail until implementation is updated.

**Step 2: Add generation input/result types**

In `shared/agent-backend-provider-types.ts`, replace generic generation inputs with typed contracts:

```ts
export interface TextGenerationInput {
  model: string;
  prompt: string;
  skillName?: string | null;
  thinkingEffort?: ThinkingEffort | null;
  cwd?: string;
  allowedTools?: string[];
  abortController: AbortController;
  usageContext?: AiUsageContext;
}

export interface StructuredGenerationInput extends TextGenerationInput {
  outputSchema: Record<string, unknown>;
}

export interface GenerationOutput {
  output: unknown | null;
}
```

Update:

```ts
export interface TextGenerationCapability {
  generate(input: TextGenerationInput): Promise<GenerationOutput>;
}

export interface StructuredGenerationCapability {
  generate(input: StructuredGenerationInput): Promise<GenerationOutput>;
  mode: 'native-schema' | 'prompt-json' | 'tool-call' | 'custom';
}
```

Import `AiUsageContext` and `ThinkingEffort` from shared modules.

**Step 3: Extract provider generation implementations**

Create `electron/services/agent-backends/provider-generation.ts`.

Move logic from `ai-generation-service.ts` into:

- `claudeCodeTextGenerationCapability`
- `claudeCodeStructuredGenerationCapability`
- `openCodeTextGenerationCapability`
- `openCodeStructuredGenerationCapability`

Keep behavior identical:

- Claude uses `query()`
- OpenCode uses `getOrCreateServer()`
- OpenCode structured generation keeps SDK `format` and JSON fallback
- usage tracking remains as-is
- helper functions `extractOpenCodeResponseOutput`, `parseOpenCodeModel`, `parseJsonResponse`, `summarizeForDebug` move with the implementation

Each capability returns `{ output }`.

**Step 4: Wire provider capabilities**

In `providers.ts`:

- import generation capabilities
- support Claude Code `generation.text` and `generation.structured`
- support OpenCode `generation.text` and `generation.structured`
- leave Codex unsupported with explicit reasons
- preserve all Phase 1 capability behavior

**Step 5: Convert `generateText()` to compatibility wrapper**

In `ai-generation-service.ts`:

- remove backend switch and backend-specific implementation helpers
- create `AbortController` and timeout exactly as before
- resolve provider via `getAgentBackendProvider(backend)`
- choose:
  - `provider.capabilities.generation.structured` when `outputSchema` exists
  - `provider.capabilities.generation.text` otherwise
- call `requireCapability(provider.id, 'generation.structured' | 'generation.text', capability)`
- return `result.output`
- preserve existing catch behavior:
  - timeout: return `null` unless `throwOnError`
  - unsupported/error: return `null` unless `throwOnError`
  - `throwOnError`: throw same top-level style `AI generation failed: ...`

**Step 6: Verify targeted tests**

Run:

```bash
pnpm test electron/services/ai-generation-service.test.ts electron/services/agent-backends/providers.test.ts
```

Expected: pass.

**Step 7: Verify types**

Run:

```bash
pnpm ts-check
```

Expected: pass.

**Step 8: No commit**

Leave changes uncommitted.

