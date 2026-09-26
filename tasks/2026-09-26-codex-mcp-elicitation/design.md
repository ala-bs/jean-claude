# Codex MCP Elicitation — Design
Date: 2026-09-26

## Problem

Codex emits native `item/tool/requestUserInput` requests with a short or
model-controlled auto-resolution path. Jean-Claude currently displays those
requests directly, while its existing `ask_question` MCP tool uses a separate
HTTP bridge. We need Codex MCP interactions to use the Jean-Claude question UI
without relying on Codex's native auto-resolution behavior.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Codex receives server requests through one dispatcher | `electron/services/agent-backends/codex/codex-backend.ts` |
| Existing UI question queue accepts normalized questions | `electron/services/agent-service.ts` and `shared/agent-backend-types.ts` |
| Existing MCP question bridge already owns UI delivery and answer polling | `electron/services/jc-mcp-bridge-service.ts`, `electron/mcp/ask-question-bridge.ts` |
| Codex 0.155.0 exposes `mcpServer/elicitation/request` and accept/decline/cancel responses | locally generated app-server schema |
| Codex currently does not receive `mcpServers` from the generic backend config | `CodexBackend.start()` only uses thread configuration |

## Decisions

| # | Decision | Chosen | Why |
| --- | --- | --- | --- |
| 1 | Protocol path | Native Codex MCP elicitation | App-controlled interaction without depending on model tool selection or `autoResolutionMs`. |
| 2 | UI | Reuse the existing question UI and pending-request queue | Avoids a second renderer flow and preserves answer validation. |
| 3 | Supported elicitation mode | `form` first; reject unsupported modes safely | Codex's current schema provides structured form fields; URL elicitation cannot be represented by the existing question UI. |
| 4 | Decline/cancel behavior | Respond with the corresponding MCP action and clear the pending UI request | Prevents Codex from remaining blocked after session stop or user cancellation. |

## In scope

- Handle `mcpServer/elicitation/request` in the Codex app-server dispatcher.
- Convert supported form schemas into normalized Jean-Claude questions.
- Convert submitted answers back into typed elicitation content.
- Add lifecycle cleanup and tests for accept, decline, cancel, unsupported mode,
  and session shutdown.

## Out of scope

- Changing Codex's native `item/tool/requestUserInput` behavior.
- Supporting URL-mode elicitation in the question UI.
- Replacing the existing Claude/OpenCode MCP bridge.

## Architecture

```text
Codex app-server
      │ mcpServer/elicitation/request
      ▼
CodexBackend ── normalized question ──► AgentService pending queue
      ▲                                      │
      │ elicitation response                 ▼
Codex RPC ◄──────── answer ◄──────── Jean-Claude question UI
```

## Interfaces

Codex pending elicitation state:

```ts
type PendingCodexQuestion = {
  client: CodexJsonRpcClient;
  rpcId: CodexJsonRpcId;
  request: NormalizedQuestionRequest;
  kind: 'user-input' | 'mcp-elicitation';
  schema?: Record<string, unknown>;
};
```

For `mcp-elicitation`, the response is:

```ts
{ action: 'accept'; content: Record<string, unknown> }
```

or `{ action: 'decline' }` / `{ action: 'cancel' }`.

## Error handling

- Unsupported elicitation mode: respond `decline`, emit a diagnostic, and do
  not leave a UI request pending.
- Invalid form schema: respond `decline` and log the schema rejection reason.
- Session cleanup: respond `cancel` for every pending elicitation.
- Invalid UI answer: retain the existing question validation behavior and do not
  send a malformed Codex response.

## Test strategy

- Unit-test schema normalization for string, enum, multi-select, number,
  integer, and boolean fields.
- Unit-test typed answer conversion and all three response actions.
- Unit-test dispatcher routing and unsupported request handling.
- Run the repository-required install, test, lint-fix, type-check, and lint
  commands.

## Rollout & rollback

No migration or feature flag. The new handler is additive. Rollback is a code
revert; native Codex user-input handling remains available.
