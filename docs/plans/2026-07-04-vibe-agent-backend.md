# Vibe Agent Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Mistral Vibe as an agent backend using `vibe-acp`, with prompt streaming, tool display, permissions, modes, models, and UI selection.

**Architecture:** Implement a new `vibe` backend beside `codex`, backed by an ACP JSON-RPC client over stdio. Normalize ACP `session/update` notifications into Jean-Claude `AgentEvent`s, and map Jean-Claude permissions/modes/models onto ACP requests.

**Tech Stack:** TypeScript, Electron main process, Vitest, ACP JSON-RPC over stdio, `vibe-acp` CLI, React settings UI.

---

### Task 1: Add Vibe Backend Type And Registry Entries

**Files:**
- Modify: `shared/agent-backend-types.ts:29`
- Modify: `electron/services/agent-backends/index.ts:9-24`
- Modify: `electron/services/agent-backends/providers.ts:285-365`
- Modify: `electron/services/agent-backends/providers.test.ts:80-116`
- Modify: `shared/agent-backend-metadata.ts:3-9`

**Step 1: Write failing provider test**

In `electron/services/agent-backends/providers.test.ts`, update hoisted mocks and expected backend lists:

```ts
vi.mock('./vibe/vibe-backend', () => ({
  VibeBackend: TestBackend,
}));

const BACKEND_TYPES: AgentBackendType[] = [
  'claude-code',
  'opencode',
  'codex',
  'copilot',
  'vibe',
];
const BACKEND_LABELS: Record<AgentBackendType, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  vibe: 'Mistral Vibe',
};
const BACKEND_BADGES: Partial<Record<AgentBackendType, string>> = {
  copilot: 'Beta',
  vibe: 'Beta',
};
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/providers.test.ts`

Expected: FAIL because `vibe` is not assignable or no provider exists.

**Step 3: Add backend type and provider**

In `shared/agent-backend-types.ts`, change:

```ts
export type AgentBackendType = 'claude-code' | 'opencode' | 'codex' | 'copilot';
```

to:

```ts
export type AgentBackendType =
  | 'claude-code'
  | 'opencode'
  | 'codex'
  | 'copilot'
  | 'vibe';
```

In `shared/agent-backend-metadata.ts`, change badge map:

```ts
const AGENT_BACKEND_BADGES: Partial<
  Record<AgentBackendType, AgentBackendBadge>
> = {
  copilot: 'Beta',
  vibe: 'Beta',
};
```

In `electron/services/agent-backends/index.ts`, import and register:

```ts
import { VibeBackend } from './vibe/vibe-backend';

export const AGENT_BACKEND_CLASSES: Record<
  AgentBackendType,
  AgentBackendClass
> = {
  'claude-code': ClaudeCodeBackend,
  opencode: OpenCodeBackend,
  codex: CodexBackend,
  copilot: CopilotBackend,
  vibe: VibeBackend,
};
```

In `electron/services/agent-backends/providers.ts`, add provider:

```ts
export const vibeProvider: AgentBackendProvider = {
  id: 'vibe',
  label: 'Mistral Vibe',
  badge: getAgentBackendBadge('vibe'),
  capabilities: createCapabilities({
    backend: 'vibe',
    run: createRunCapability({
      backendType: 'vibe',
      loadBackendClass: async () =>
        (await import('./vibe/vibe-backend')).VibeBackend,
    }),
    supportsPermissions: true,
    supportsQuestions: false,
    supportsRuntimeModeSwitch: true,
    supportsSessionAllowedTools: false,
  }),
};

export const AGENT_BACKEND_PROVIDERS: Record<
  AgentBackendType,
  AgentBackendProvider
> = {
  'claude-code': claudeCodeProvider,
  opencode: openCodeProvider,
  codex: codexProvider,
  copilot: copilotProvider,
  vibe: vibeProvider,
};
```

**Step 4: Add placeholder backend**

Create `electron/services/agent-backends/vibe/vibe-backend.ts`:

```ts
import type {
  AgentBackend,
  AgentBackendConfig,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionResponse,
  PromptPart,
} from '@shared/agent-backend-types';
import type { InteractionMode } from '@shared/types';

export class VibeBackend implements AgentBackend {
  constructor(private readonly taskContext: AgentTaskContext) {}

  async start(
    _config: AgentBackendConfig,
    _parts: PromptPart[],
  ): Promise<AgentSession> {
    void this.taskContext;
    throw new Error('Vibe backend is not implemented yet');
  }

  async stop(_sessionId: string): Promise<void> {}

  async respondToPermission(
    _sessionId: string,
    _requestId: string,
    _response: NormalizedPermissionResponse,
  ): Promise<void> {}

  async respondToQuestion(
    _sessionId: string,
    _requestId: string,
    _answer: Record<string, string>,
  ): Promise<void> {}

  async setMode(_sessionId: string, _mode: InteractionMode): Promise<void> {}

  async dispose(): Promise<void> {}
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/providers.test.ts`

Expected: PASS.

**Step 6: Commit**

Run:

```bash
git add shared/agent-backend-types.ts shared/agent-backend-metadata.ts electron/services/agent-backends/index.ts electron/services/agent-backends/providers.ts electron/services/agent-backends/providers.test.ts electron/services/agent-backends/vibe/vibe-backend.ts
git commit -m "feat(agent): register vibe backend"
```

---

### Task 2: Add Shared ACP JSON-RPC Client For Vibe

**Files:**
- Create: `electron/services/agent-backends/acp-json-rpc-client.ts`
- Create: `electron/services/agent-backends/acp-json-rpc-client.test.ts`
- Reference: `electron/services/agent-backends/codex/codex-json-rpc-client.ts:1-370`

**Step 1: Write failing tests**

Create `electron/services/agent-backends/acp-json-rpc-client.test.ts`:

```ts
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it, vi } from 'vitest';

import { AcpJsonRpcClient } from './acp-json-rpc-client';

function createProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

describe('AcpJsonRpcClient', () => {
  it('writes JSON-RPC requests and resolves responses', async () => {
    const proc = createProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const writes: string[] = [];
    proc.stdin.on('data', (chunk) => writes.push(chunk.toString()));

    const promise = client.request('initialize', { protocolVersion: 1 });
    expect(JSON.parse(writes[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });

    proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('emits notifications', () => {
    const proc = createProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const listener = vi.fn();
    client.onNotification(listener);

    proc.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1' } }) + '\n',
    );

    expect(listener).toHaveBeenCalledWith({
      method: 'session/update',
      params: { sessionId: 's1' },
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/acp-json-rpc-client.test.ts`
Expected: FAIL because module missing.

**Step 3: Implement client**

Copy `CodexJsonRpcClient` into `electron/services/agent-backends/acp-json-rpc-client.ts`, rename exports:

```ts
export type AcpJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type AcpJsonRpcProcess = Pick<EventEmitter, 'on' | 'off'> & {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill: () => void;
};

export class AcpJsonRpcClient { /* same implementation as CodexJsonRpcClient */ }
```

Use same newline JSON-RPC behavior, request timeout, notification listener, and disposal logic.

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/acp-json-rpc-client.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/agent-backends/acp-json-rpc-client.ts electron/services/agent-backends/acp-json-rpc-client.test.ts
git commit -m "feat(agent): add acp json rpc client"
```

---

### Task 3: Add Vibe ACP Process Server

**Files:**
- Create: `electron/services/agent-backends/vibe/vibe-acp-server.ts`
- Create: `electron/services/agent-backends/vibe/vibe-acp-server.test.ts`
- Reference: `electron/services/agent-backends/codex/codex-app-server.ts:1-140`

**Step 1: Write failing tests**

Create `electron/services/agent-backends/vibe/vibe-acp-server.test.ts`:

```ts
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  request: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));

vi.mock('../acp-json-rpc-client', () => ({
  AcpJsonRpcClient: vi.fn().mockImplementation(() => ({
    request: mocks.request,
    notify: mocks.notify,
    dispose: vi.fn(),
  })),
}));

import { getOrCreateVibeAcpServer, resetVibeAcpServerForTest } from './vibe-acp-server';

function createProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 9876;
  proc.kill = vi.fn();
  return proc;
}

describe('vibe-acp server', () => {
  beforeEach(async () => {
    await resetVibeAcpServerForTest();
    vi.clearAllMocks();
    mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'vibe-acp 2.19.0', ''));
    mocks.spawn.mockReturnValue(createProc());
    mocks.request.mockResolvedValue({ protocolVersion: 1 });
  });

  it('checks vibe-acp availability and initializes server', async () => {
    const handle = await getOrCreateVibeAcpServer();

    expect(mocks.execFile).toHaveBeenCalledWith(
      'vibe-acp',
      ['--version'],
      { timeout: 5_000 },
      expect.any(Function),
    );
    expect(mocks.spawn).toHaveBeenCalledWith('vibe-acp', [], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mocks.request).toHaveBeenCalledWith('initialize', expect.objectContaining({
      protocolVersion: expect.any(Number),
      clientInfo: expect.objectContaining({ name: 'jean_claude' }),
    }));
    expect(mocks.notify).toHaveBeenCalledWith('initialized', {});
    expect(handle.rootPid).toBe(9876);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-acp-server.test.ts`
Expected: FAIL because module missing.

**Step 3: Implement server**

Create `electron/services/agent-backends/vibe/vibe-acp-server.ts`:

```ts
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { dbg } from '../../../lib/debug';
import { AcpJsonRpcClient } from '../acp-json-rpc-client';

export interface VibeAcpServerHandle {
  client: AcpJsonRpcClient;
  rootPid?: number;
  dispose(): Promise<void>;
}

const APP_VERSION = '0.0.1';
const ACP_PROTOCOL_VERSION = 1;
const execFileAsync = promisify(execFile);

type VibeAcpServerState = {
  promise: Promise<VibeAcpServerHandle>;
  handle?: VibeAcpServerHandle;
};

let serverState: VibeAcpServerState | undefined;

export async function getOrCreateVibeAcpServer(): Promise<VibeAcpServerHandle> {
  if (serverState === undefined) {
    let state: VibeAcpServerState;
    const clearIfCurrent = () => {
      if (serverState === state) serverState = undefined;
    };
    const promise = startVibeAcpServer(clearIfCurrent)
      .then(async (handle) => {
        state.handle = handle;
        if (serverState !== state) {
          await handle.dispose();
          throw new Error('Vibe ACP startup was superseded');
        }
        return handle;
      })
      .catch((error: unknown) => {
        clearIfCurrent();
        throw error;
      });
    state = { promise };
    serverState = state;
  }
  return serverState.promise;
}

export async function resetVibeAcpServerForTest(): Promise<void> {
  const state = serverState;
  serverState = undefined;
  if (state?.handle) await state.handle.dispose();
}

async function startVibeAcpServer(
  clearIfCurrent: () => void,
): Promise<VibeAcpServerHandle> {
  await assertVibeAcpAvailable();

  const proc = spawn('vibe-acp', [], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new AcpJsonRpcClient({ process: proc });

  const clearOnTerminal = () => clearIfCurrent();
  proc.on('exit', clearOnTerminal);
  proc.on('error', clearOnTerminal);
  proc.stderr.on('data', (chunk: Buffer) => {
    dbg.agent('vibe-acp stderr: %s', chunk.toString().trimEnd());
  });

  let disposed = false;
  const handle: VibeAcpServerHandle = {
    client,
    rootPid: proc.pid,
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearIfCurrent();
      proc.off('exit', clearOnTerminal);
      proc.off('error', clearOnTerminal);
      client.dispose();
    },
  };

  try {
    await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'jean_claude', title: 'Jean-Claude', version: APP_VERSION },
      clientCapabilities: {
        terminal: false,
        fs: { readTextFile: false, writeTextFile: false },
        fieldMeta: { 'terminal-auth': false },
      },
    });
    await client.notify('initialized', {});
  } catch (error) {
    await handle.dispose();
    throw error;
  }

  return handle;
}

async function assertVibeAcpAvailable(): Promise<void> {
  try {
    await execFileAsync('vibe-acp', ['--version'], { timeout: 5_000 });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(
        'Mistral Vibe not found. Install `mistral-vibe`, ensure `vibe-acp` is on PATH, then run `vibe-acp --setup` or set MISTRAL_API_KEY.',
      );
    }
    throw new Error(
      `Unable to run vibe-acp: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-acp-server.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/agent-backends/vibe/vibe-acp-server.ts electron/services/agent-backends/vibe/vibe-acp-server.test.ts
git commit -m "feat(agent): start vibe acp server"
```

---

### Task 4: Normalize Vibe ACP Updates

**Files:**
- Create: `electron/services/agent-backends/vibe/normalize-vibe-message-v2.ts`
- Create: `electron/services/agent-backends/vibe/normalize-vibe-message-v2.test.ts`
- Reference: `shared/normalized-message-v2.ts`
- Reference: `electron/services/agent-backends/codex/normalize-codex-message-v2.ts:1-999`

**Step 1: Write failing normalizer tests**

Create `electron/services/agent-backends/vibe/normalize-vibe-message-v2.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createVibeNormalizationContext,
  normalizeVibeNotification,
} from './normalize-vibe-message-v2';

describe('normalizeVibeNotification', () => {
  it('emits assistant message chunks and updates same message', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'vibe-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-1',
              content: { type: 'text', text: 'Hello' },
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hello',
        }),
      },
    ]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'vibe-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-1',
              content: { type: 'text', text: ' world' },
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hello world',
        }),
      },
    ]);
  });

  it('maps tool call and completion updates', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'vibe-session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'bash: pnpm test',
              kind: 'terminal',
              content: [{ type: 'content', content: { type: 'text', text: 'pnpm test' } }],
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          name: 'bash',
          input: { command: 'pnpm test' },
        }),
      },
    ]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'vibe-session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'PASS' } }],
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          result: { content: 'PASS', isError: false },
        }),
      },
    ]);
  });

  it('maps usage update to result update', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'vibe-session-1',
            update: {
              sessionUpdate: 'usage_update',
              used: 100,
              size: 200000,
              cost: { amount: 0.01, currency: 'USD' },
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'result-update',
        result: expect.objectContaining({
          totalCost: 0.01,
          usage: { inputTokens: 100, outputTokens: 0 },
        }),
      },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/vibe/normalize-vibe-message-v2.test.ts`
Expected: FAIL because normalizer missing.

**Step 3: Implement minimal normalizer**

Create `electron/services/agent-backends/vibe/normalize-vibe-message-v2.ts` with tolerant parsing:

```ts
import type {
  NormalizationEvent,
  NormalizedEntry,
  NormalizedResult,
} from '@shared/normalized-message-v2';

export type VibeNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type VibeNormalizationContext = {
  entries: Map<string, NormalizedEntry>;
  messageText: Map<string, string>;
  totalCost: number;
};

export function createVibeNormalizationContext(): VibeNormalizationContext {
  return { entries: new Map(), messageText: new Map(), totalCost: 0 };
}

export function normalizeVibeNotification(
  notification: VibeNotification,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  if (notification.method !== 'session/update') return [];
  const params = notification.params ?? {};
  const update = record(params.update);
  const kind = str(update?.sessionUpdate) ?? str(update?.session_update);

  if (kind === 'agent_message_chunk') return normalizeMessageChunk(update, ctx);
  if (kind === 'agent_thought_chunk') return normalizeThoughtChunk(update, ctx);
  if (kind === 'tool_call') return normalizeToolCall(update, ctx);
  if (kind === 'tool_call_update') return normalizeToolCallUpdate(update, ctx);
  if (kind === 'usage_update') return normalizeUsageUpdate(update, ctx);
  return [];
}

function normalizeMessageChunk(
  update: Record<string, unknown>,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  const id = str(update.messageId) ?? str(update.message_id) ?? `message-${ctx.messageText.size + 1}`;
  const delta = textFromContent(update.content);
  if (delta === undefined) return [];
  const value = (ctx.messageText.get(id) ?? '') + delta;
  const existing = ctx.entries.get(id);
  const entry: NormalizedEntry = {
    ...(existing?.type === 'assistant-message' ? existing : { id, date: new Date().toISOString(), type: 'assistant-message' as const }),
    value,
  };
  ctx.messageText.set(id, value);
  ctx.entries.set(id, entry);
  return [{ type: existing ? 'entry-update' : 'entry', entry }];
}

function normalizeThoughtChunk(
  update: Record<string, unknown>,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  const id = str(update.messageId) ?? str(update.message_id) ?? `thought-${ctx.messageText.size + 1}`;
  const delta = textFromContent(update.content);
  if (delta === undefined) return [];
  const value = (ctx.messageText.get(id) ?? '') + delta;
  const existing = ctx.entries.get(id);
  const entry: NormalizedEntry = {
    ...(existing?.type === 'thinking' ? existing : { id, date: new Date().toISOString(), type: 'thinking' as const }),
    value,
  };
  ctx.messageText.set(id, value);
  ctx.entries.set(id, entry);
  return [{ type: existing ? 'entry-update' : 'entry', entry }];
}

function normalizeToolCall(
  update: Record<string, unknown>,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  const id = str(update.toolCallId) ?? str(update.tool_call_id);
  if (!id) return [];
  const title = str(update.title) ?? 'tool';
  const name = toolNameFromTitle(title);
  const content = contentListText(update.content);
  const entry: NormalizedEntry = {
    id,
    date: new Date().toISOString(),
    type: 'tool-use',
    name,
    input: name === 'bash' ? { command: content ?? title } : { content: content ?? title },
  };
  ctx.entries.set(id, entry);
  return [{ type: 'entry', entry }];
}

function normalizeToolCallUpdate(
  update: Record<string, unknown>,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  const id = str(update.toolCallId) ?? str(update.tool_call_id);
  if (!id) return [];
  const existing = ctx.entries.get(id);
  if (existing?.type !== 'tool-use') return [];
  const status = str(update.status);
  const content = contentListText(update.content) ?? '';
  const entry: NormalizedEntry = {
    ...existing,
    result: { content, isError: status === 'failed' || status === 'error' },
  };
  ctx.entries.set(id, entry);
  return [{ type: 'entry-update', entry }];
}

function normalizeUsageUpdate(
  update: Record<string, unknown>,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  const cost = record(update.cost);
  const amount = num(cost?.amount) ?? 0;
  ctx.totalCost = amount;
  const result: NormalizedResult = {
    isError: false,
    totalCost: amount,
    usage: { inputTokens: num(update.used) ?? 0, outputTokens: 0 },
  };
  return [{ type: 'result-update', result }];
}

function toolNameFromTitle(title: string): string {
  const lower = title.toLowerCase();
  if (lower.startsWith('bash') || lower.includes('terminal')) return 'bash';
  if (lower.startsWith('read')) return 'read';
  if (lower.startsWith('edit')) return 'edit';
  if (lower.startsWith('write')) return 'write_file';
  if (lower.startsWith('grep')) return 'grep';
  return title.split(/[:\s]/)[0] || 'tool';
}

function contentListText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return textFromContent(value);
  return value.map((item) => textFromContent(record(item)?.content ?? item)).filter(Boolean).join('\n') || undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const obj = record(value);
  return str(obj?.text);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/vibe/normalize-vibe-message-v2.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/agent-backends/vibe/normalize-vibe-message-v2.ts electron/services/agent-backends/vibe/normalize-vibe-message-v2.test.ts
git commit -m "feat(agent): normalize vibe acp updates"
```

---

### Task 5: Implement Vibe Backend Start, Prompt, Stop

**Files:**
- Modify: `electron/services/agent-backends/vibe/vibe-backend.ts`
- Create: `electron/services/agent-backends/vibe/vibe-backend.test.ts`
- Reference: `electron/services/agent-backends/codex/codex-backend.ts:110-450`

**Step 1: Write failing backend tests**

Create `electron/services/agent-backends/vibe/vibe-backend.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackendConfig, AgentTaskContext } from '@shared/agent-backend-types';

const mocks = vi.hoisted(() => ({
  getOrCreateVibeAcpServer: vi.fn(),
}));

vi.mock('./vibe-acp-server', () => ({
  getOrCreateVibeAcpServer: mocks.getOrCreateVibeAcpServer,
}));

import { VibeBackend } from './vibe-backend';

describe('VibeBackend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a session and sends prompt blocks', async () => {
    const { backend, client } = createBackend();

    const session = await backend.start(createConfig({ model: 'mistral-medium-3.5' }), [
      { type: 'text', text: 'Analyze this' },
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      { type: 'file', filePath: '/tmp/a.txt', filename: 'a.txt' },
    ]);

    expect(client.request).toHaveBeenCalledWith('session/new', {
      cwd: '/tmp/project',
      mcpServers: [],
    });
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', {
      sessionId: 'vibe-session-1',
      configId: 'model',
      value: 'mistral-medium-3.5',
    });
    expect(client.request).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'vibe-session-1',
      modeId: 'default',
    });
    expect(client.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'vibe-session-1',
      prompt: [
        { type: 'text', text: 'Analyze this' },
        { type: 'image', mimeType: 'image/png', data: 'base64-data' },
        { type: 'text', text: 'Attached file: /tmp/a.txt' },
      ],
    });
    expect(session.sessionId).toBe('vibe-session-1');
  });

  it('loads an existing session when config.sessionId is present', async () => {
    const { backend, client } = createBackend();

    await backend.start(createConfig({ sessionId: 'existing-session' }), [
      { type: 'text', text: 'Continue' },
    ]);

    expect(client.request).toHaveBeenCalledWith('session/load', {
      cwd: '/tmp/project',
      sessionId: 'existing-session',
      mcpServers: [],
    });
    expect(client.request).not.toHaveBeenCalledWith('session/new', expect.anything());
  });

  it('persists raw session updates and yields normalized entries', async () => {
    const { backend, client, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);
    const iterator = session.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session-id', sessionId: 'vibe-session-1' },
    });

    const next = iterator.next();
    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: 'entry',
        entry: expect.objectContaining({ id: 'msg-1', type: 'assistant-message', value: 'Hi' }),
        rawMessageId: 'raw-1',
      },
    });
    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 7,
      backendSessionId: 'vibe-session-1',
      rawData: expect.objectContaining({ method: 'session/update' }),
    });
    expect(client.request).toHaveBeenCalled();
  });
});

function createBackend() {
  let notificationListener: ((notification: unknown) => void) | undefined;
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === 'session/new') return { sessionId: 'vibe-session-1' };
      if (method === 'session/load') return {};
      return {};
    }),
    notify: vi.fn(),
    onNotification: vi.fn((listener) => {
      notificationListener = listener;
      return () => undefined;
    }),
  };
  mocks.getOrCreateVibeAcpServer.mockResolvedValue({ client, rootPid: 1234, dispose: vi.fn() });
  const persistRaw = vi.fn(async () => 'raw-1');
  const context: AgentTaskContext = {
    taskId: 'task-1',
    sessionStartIndex: 7,
    persistRaw,
  };
  return {
    backend: new VibeBackend(context),
    client,
    persistRaw,
    emitNotification(notification: unknown) {
      notificationListener?.(notification);
    },
  };
}

function createConfig(overrides: Partial<AgentBackendConfig> = {}): AgentBackendConfig {
  return {
    type: 'vibe',
    cwd: '/tmp/project',
    interactionMode: 'ask',
    ...overrides,
  };
}
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-backend.test.ts`
Expected: FAIL because backend throws not implemented.

**Step 3: Implement backend**

In `electron/services/agent-backends/vibe/vibe-backend.ts`, implement:

```ts
import { nanoid } from 'nanoid';

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentEvent,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionResponse,
  PromptPart,
} from '@shared/agent-backend-types';
import type { InteractionMode } from '@shared/types';

import type { AcpJsonRpcNotification } from '../acp-json-rpc-client';
import { getOrCreateVibeAcpServer } from './vibe-acp-server';
import {
  createVibeNormalizationContext,
  normalizeVibeNotification,
  type VibeNormalizationContext,
} from './normalize-vibe-message-v2';

class AsyncEventChannel<T> { /* copy small class from CodexBackend */ }

type VibeSessionState = {
  sessionId: string;
  eventChannel: AsyncEventChannel<AgentEvent>;
  unsubscribe: (() => void) | null;
  normalizationCtx: VibeNormalizationContext;
  messageIndex: number;
  closed: boolean;
  rootPid?: number;
  pendingPermissions: Map<string, { optionIds: string[] }>;
};

export class VibeBackend implements AgentBackend {
  private readonly sessions = new Map<string, VibeSessionState>();

  constructor(private readonly taskContext: AgentTaskContext) {}

  async start(config: AgentBackendConfig, parts: PromptPart[]): Promise<AgentSession> {
    const localSessionId = nanoid();
    const { client, rootPid } = await getOrCreateVibeAcpServer();
    const state: VibeSessionState = {
      sessionId: localSessionId,
      eventChannel: new AsyncEventChannel<AgentEvent>(),
      unsubscribe: null,
      normalizationCtx: createVibeNormalizationContext(),
      messageIndex: this.taskContext.sessionStartIndex,
      closed: false,
      rootPid,
      pendingPermissions: new Map(),
    };
    this.sessions.set(localSessionId, state);

    const sessionResult = config.sessionId
      ? await client.request('session/load', {
          cwd: config.cwd,
          sessionId: config.sessionId,
          mcpServers: toAcpMcpServers(config.mcpServers),
        })
      : await client.request('session/new', {
          cwd: config.cwd,
          mcpServers: toAcpMcpServers(config.mcpServers),
        });
    const nativeSessionId = sessionIdFromResult(sessionResult) ?? config.sessionId ?? localSessionId;
    state.sessionId = nativeSessionId;
    this.sessions.delete(localSessionId);
    this.sessions.set(nativeSessionId, state);
    state.eventChannel.push({ type: 'session-id', sessionId: nativeSessionId });

    state.unsubscribe = client.onNotification((notification) => {
      void this.handleNotification(state, notification as AcpJsonRpcNotification);
    });

    if (config.model && config.model !== 'default') {
      await client.request('session/set_config_option', {
        sessionId: nativeSessionId,
        configId: 'model',
        value: config.model,
      });
    }
    await client.request('session/set_mode', {
      sessionId: nativeSessionId,
      modeId: toVibeMode(config.interactionMode),
    });
    await client.request('session/prompt', {
      sessionId: nativeSessionId,
      prompt: partsToVibePrompt(parts),
    });

    return { sessionId: nativeSessionId, events: state.eventChannel, rootPid };
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.closed = true;
    const { client } = await getOrCreateVibeAcpServer();
    await client.notify('session/cancel', { sessionId }).catch(() => undefined);
    state.unsubscribe?.();
    state.eventChannel.close();
    this.sessions.delete(sessionId);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: NormalizedPermissionResponse,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`No Vibe session: ${sessionId}`);
    const pending = state.pendingPermissions.get(requestId);
    const { client } = await getOrCreateVibeAcpServer();
    const optionId = response.behavior === 'allow'
      ? pending?.optionIds.find((id) => /allow/i.test(id)) ?? pending?.optionIds[0] ?? 'allow_once'
      : pending?.optionIds.find((id) => /reject|deny|cancel/i.test(id)) ?? 'reject_once';
    await client.request('session/request_permission/respond', {
      requestId,
      outcome: { outcome: 'selected', optionId },
    });
    state.pendingPermissions.delete(requestId);
  }

  async respondToQuestion(_sessionId: string, _requestId: string, _answer: Record<string, string>): Promise<void> {}

  async setMode(sessionId: string, mode: InteractionMode): Promise<void> {
    const { client } = await getOrCreateVibeAcpServer();
    await client.request('session/set_mode', { sessionId, modeId: toVibeMode(mode) });
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.stop(id)));
  }

  private async handleNotification(state: VibeSessionState, notification: AcpJsonRpcNotification): Promise<void> {
    if (state.closed) return;
    if (notification.method === 'session/request_permission') {
      this.emitPermissionRequest(state, notification);
      return;
    }
    if (notification.method !== 'session/update') return;
    const rawMessageId = await this.taskContext.persistRaw({
      messageIndex: state.messageIndex++,
      backendSessionId: state.sessionId,
      rawData: notification,
    });
    for (const event of normalizeVibeNotification({ method: notification.method, params: record(notification.params) }, state.normalizationCtx)) {
      state.eventChannel.push(event.type === 'entry' ? { ...event, rawMessageId } : event);
    }
  }

  private emitPermissionRequest(state: VibeSessionState, notification: AcpJsonRpcNotification): void {
    const params = record(notification.params) ?? {};
    const requestId = str(params.requestId) ?? str(params.request_id) ?? nanoid();
    const toolCall = record(params.toolCall) ?? record(params.tool_call) ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    state.pendingPermissions.set(requestId, {
      optionIds: options.map((option) => str(record(option)?.optionId) ?? str(record(option)?.option_id)).filter((id): id is string => Boolean(id)),
    });
    state.eventChannel.push({
      type: 'permission-request',
      request: {
        requestId,
        toolName: str(toolCall.title) ?? str(params.description) ?? 'tool',
        input: {},
      },
    });
  }
}

function partsToVibePrompt(parts: PromptPart[]): unknown[] { /* text, image, file as tests expect */ }
function toVibeMode(mode: InteractionMode): string { if (mode === 'plan') return 'plan'; if (mode === 'auto') return 'auto-approve'; return 'default'; }
function toAcpMcpServers(_servers: AgentBackendConfig['mcpServers']): unknown[] { return []; }
function sessionIdFromResult(result: unknown): string | null { const obj = record(result); return str(obj?.sessionId) ?? str(obj?.session_id) ?? null; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
```

Implement omitted helpers to satisfy tests. Keep MCP conversion returning `[]` for first pass.

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-backend.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/agent-backends/vibe/vibe-backend.ts electron/services/agent-backends/vibe/vibe-backend.test.ts
git commit -m "feat(agent): run vibe acp sessions"
```

---

### Task 6: Add Vibe Model Discovery Fallback

**Files:**
- Modify: `electron/services/backend-models-service.ts:20-119`
- Modify: existing tests if present, or create `electron/services/backend-models-service.test.ts`

**Step 1: Write failing model test**

Create or extend backend model test with:

```ts
import { describe, expect, it } from 'vitest';

import { getBackendModels } from './backend-models-service';

describe('getBackendModels vibe', () => {
  it('returns Mistral Vibe defaults', async () => {
    await expect(getBackendModels('vibe')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5' }),
      ]),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/backend-models-service.test.ts`
Expected: FAIL because `vibe` returns empty.

**Step 3: Implement fallback models**

In `electron/services/backend-models-service.ts`, add:

```ts
const VIBE_MODELS: BackendModel[] = [
  { id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5', supportsThinking: false },
  { id: 'codestral-latest', label: 'Codestral Latest', supportsThinking: false },
];
```

Then in `getBackendModels`:

```ts
if (backend === 'vibe') {
  return VIBE_MODELS;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/backend-models-service.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/backend-models-service.ts electron/services/backend-models-service.test.ts
git commit -m "feat(agent): add vibe model defaults"
```

---

### Task 7: Expose Vibe In Settings And Onboarding

**Files:**
- Modify: `src/features/settings/ui-general-settings/index.tsx:834-927`
- Modify: `src/routes/onboarding/setup.tsx:71-110`
- Modify: `src/routes/projects/new.tsx:31-50`
- Search follow-ups: `src/**/*.{ts,tsx}` for hard-coded backend maps

**Step 1: Write failing type/check expectation**

Run current typecheck after backend type is added:

```bash
pnpm ts-check
```

Expected: FAIL at hard-coded `Record<AgentBackendType, ...>` or missing map entries for `vibe`.

**Step 2: Add UI labels/descriptions**

In `src/routes/onboarding/setup.tsx`, add option:

```ts
{
  id: 'vibe',
  name: 'Mistral Vibe',
  detail: 'Use Mistral Vibe via vibe-acp. Requires MISTRAL_API_KEY or vibe-acp setup.',
},
```

Add source badge:

```ts
vibe: {
  className:
    'rounded px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/15 text-orange-300',
  label: 'Vibe',
},
```

In `src/routes/projects/new.tsx`, add same `vibe` badge config.

In `src/features/settings/ui-general-settings/index.tsx`, verify `AVAILABLE_BACKENDS` includes `vibe`. If it lives in this file, add:

```ts
{
  value: 'vibe',
  label: 'Mistral Vibe',
  description:
    'Uses Mistral Vibe through vibe-acp. Requires mistral-vibe installed and MISTRAL_API_KEY configured.',
  badge: 'Beta',
},
```

**Step 3: Fix all hard-coded backend maps**

Run: use Grep for `Record<AgentBackendType` and `['claude-code', 'opencode'`.

Update only maps where TypeScript requires `vibe`. Do not add Vibe to skill-management backend toggles unless Vibe skill symlink support is implemented.

**Step 4: Run typecheck to verify it passes**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add src/features/settings/ui-general-settings/index.tsx src/routes/onboarding/setup.tsx src/routes/projects/new.tsx
git commit -m "feat(ui): expose vibe backend"
```

---

### Task 8: Add Backend Config And Setup Messaging

**Files:**
- Modify: `src/features/settings/ui-settings-overlay/index.tsx:154-160,429-433,671-678`
- Check: backend config component path from `BackendConfigSettings` import in same file
- Modify: backend config service if it enumerates supported backends

**Step 1: Write failing typecheck/search check**

Run:

```bash
pnpm ts-check
```

Expected: may FAIL if backend config maps are exhaustive.

**Step 2: Add settings nav item**

In `src/features/settings/ui-settings-overlay/index.tsx`, add leaf:

```ts
createBackendSubItem({ id: 'vibe', label: 'Mistral Vibe' })
```

and route case:

```tsx
case 'coding-agents:vibe':
  return <BackendConfigSettings backend="vibe" />;
```

**Step 3: Ensure config screen can handle Vibe**

If `BackendConfigSettings` reads native config path, ensure Vibe maps to:

```ts
~/.vibe/config.toml
```

If existing backend config service rejects unknown backends, add `vibe` with schema URL empty or Vibe docs URL.

**Step 4: Run typecheck**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add src/features/settings/ui-settings-overlay/index.tsx electron/services
git commit -m "feat(settings): add vibe backend configuration"
```

---

### Task 9: Permission Flow Hardening

**Files:**
- Modify: `electron/services/agent-backends/vibe/vibe-backend.ts`
- Modify: `electron/services/agent-backends/vibe/vibe-backend.test.ts`

**Step 1: Add failing tests for permission request and response**

In `vibe-backend.test.ts`, add:

```ts
it('emits ACP permission requests and responds with selected option', async () => {
  const { backend, client, emitNotification } = createBackend();
  const session = await backend.start(createConfig(), [{ type: 'text', text: 'Run tests' }]);
  const iterator = session.events[Symbol.asyncIterator]();
  await iterator.next();

  const next = iterator.next();
  emitNotification({
    method: 'session/request_permission',
    params: {
      requestId: 'perm-1',
      sessionId: 'vibe-session-1',
      toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
      options: [
        { optionId: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', name: 'Reject' },
      ],
    },
  });

  await expect(next).resolves.toEqual({
    done: false,
    value: {
      type: 'permission-request',
      request: expect.objectContaining({
        requestId: 'perm-1',
        toolName: 'bash',
        input: { command: 'pnpm test' },
      }),
    },
  });

  await backend.respondToPermission('vibe-session-1', 'perm-1', { behavior: 'allow' });
  expect(client.request).toHaveBeenCalledWith('session/request_permission/respond', {
    requestId: 'perm-1',
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-backend.test.ts`
Expected: FAIL if current parsing leaves `toolName` as full title or wrong input.

**Step 3: Improve permission parsing**

Implement helpers:

```ts
function permissionToolName(title: string): string {
  if (title.toLowerCase().startsWith('bash')) return 'bash';
  return title.split(/[:\s]/)[0] || 'tool';
}

function permissionInput(title: string): Record<string, unknown> {
  if (title.toLowerCase().startsWith('bash')) {
    return { command: title.replace(/^bash\s*:?\s*/i, '') };
  }
  return { title };
}
```

Use them in `emitPermissionRequest`.

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/services/agent-backends/vibe/vibe-backend.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:

```bash
git add electron/services/agent-backends/vibe/vibe-backend.ts electron/services/agent-backends/vibe/vibe-backend.test.ts
git commit -m "feat(agent): handle vibe permissions"
```

---

### Task 10: Final Verification

**Files:**
- No new files expected

**Step 1: Install dependencies**

Run: `pnpm install`
Expected: completes without lockfile surprises unless dependency metadata changed elsewhere.

**Step 2: Run tests**

Run: `pnpm test`
Expected: PASS.

**Step 3: Run lint fix**

Run: `pnpm lint --fix`
Expected: completes; inspect changed files.

**Step 4: Run TypeScript check**

Run: `pnpm ts-check`
Expected: PASS.

**Step 5: Run final lint**

Run: `pnpm lint`
Expected: PASS.

**Step 6: Manual smoke test**

Prereq:

```bash
vibe-acp --version
vibe-acp --setup
```

Then in Jean-Claude:
- Enable `Mistral Vibe` in Settings > General > Agent Backends.
- Create task with Vibe backend.
- Prompt: `List files and tell me project package manager.`
- Expected: assistant streams text, tool call appears, permission prompt appears if needed, completion stored.

**Step 7: Commit fixes only if needed**

Run:

```bash
git status --short
git add <only-files-changed-by-verification>
git commit -m "fix(agent): polish vibe backend integration"
```

Expected: only if lint or smoke-test fixes changed files.

---

## Known Deferred Work

- Vibe MCP server conversion from Jean-Claude runtime MCP config.
- Vibe skills management in Settings > Skills.
- Full ACP file-system/terminal client capability support.
- Rich tool input parsing beyond common `bash`, `read`, `edit`, `write_file`, `grep` titles.
- Native Vibe model discovery from config/ACP result instead of static defaults.
