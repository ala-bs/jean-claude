# Codex app-server protocol compatibility — Design
Date: 2026-09-19

## Problem

Codex app-server now sends server-initiated JSON-RPC requests for command and
file-change approvals. Jean-Claude's JSON-RPC client currently classifies any
message containing an `id` as a response, so these requests are ignored. The
Codex backend also leaves its permission response methods empty. A Codex turn
that needs approval can therefore remain blocked without producing a usable
permission prompt.

## Users & success criteria

When a Codex task reaches a command or file-change approval, the existing
Jean-Claude permission UI appears. Accepting, accepting for the session,
declining, or cancelling resumes or rejects the Codex operation, and the task
continues or completes normally. Unsupported server requests fail explicitly
instead of hanging.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Codex uses a hand-written JSON-RPC client over `codex app-server` stdio | `electron/services/agent-backends/codex/codex-json-rpc-client.ts`, `codex-app-server.ts` |
| Notifications and responses are already separated by presence of `method` and `id` | `codex-json-rpc-client.ts` |
| Existing UI and service broker consume normalized permission events | `shared/agent-backend-types.ts`, `electron/services/agent-service.ts` |
| Codex permission response methods are currently no-ops | `codex-backend.ts` |
| Official protocol requires replies to command/file approval requests | OpenAI app-server protocol documentation |

## Decisions

| # | Decision | Chosen | Why | Rejected alternatives |
| --- | --- | --- | --- | --- |
| 1 | Initial protocol scope | Command and file-change approvals | Fixes the concrete compatibility failure with the smallest surface | Full dynamic tools, MCP elicitation, and all event parity are follow-ups |
| 2 | UI | Existing Jean-Claude permission broker | Preserves one permission experience across backends | New Codex-specific UI would duplicate policy and rendering |
| 3 | Transport seam | Generic `onRequest` plus JSON-RPC response methods | Keeps protocol framing in the transport and routing/policy in the backend | Backend-specific parsing inside the transport would make future requests harder |
| 4 | Unsupported requests | Return JSON-RPC method-not-found error | Makes failures observable and prevents silent hangs | Ignoring requests is the current bug |

## In scope (v1)

- Correctly classify JSON-RPC notifications, responses, and server requests.
- Expose server requests to the Codex backend.
- Normalize command-execution and file-change approval requests.
- Route them through the existing `permission-request` event.
- Map normalized responses to Codex decisions.
- Deny/resolve pending requests during session cleanup.
- Add transport and backend tests for the supported and unsupported cases.

## Out of scope

- `tool/requestUserInput` questions.
- Dynamic tool calls.
- MCP elicitation.
- Network approval-specific UX.
- Plan/diff/token-usage event normalization.
- Replacing app-server with `@openai/codex-sdk`.

## Approach chosen

```text
CodexJsonRpcClient
  ├─ response { id, result/error } ──► pending request promise
  ├─ notification { method, params } ─► onNotification()
  └─ request { id, method, params } ─► onRequest()
                                             │
                                             ▼
                                      CodexBackend
                                             │
                                             ▼
                              normalized permission event
                                             │
                                             ▼
                                      AgentService UI
                                             │
                                             ▼
                                  JSON-RPC response by id
```

The client will use a JSON-RPC id union (`number | string`) for both pending
responses and server-request replies. The backend will keep the app-server
request id associated with the normalized request id used by Jean-Claude.

## Interfaces

```ts
type CodexJsonRpcId = number | string;

type CodexJsonRpcRequest = {
  id: CodexJsonRpcId;
  method: string;
  params?: unknown;
};

onRequest(listener: (request: CodexJsonRpcRequest) => void): () => void;

respond(id: CodexJsonRpcId, result: unknown): Promise<void>;

respondError(
  id: CodexJsonRpcId,
  code: number,
  message: string,
): Promise<void>;
```

Supported server requests:

- `item/commandExecution/requestApproval`: normalized as tool `bash`, with
  command, cwd, reason, and command actions in `input`.
- `item/fileChange/requestApproval`: normalized as tool `file_change`, with
  changes, reason, and optional grant root in `input`.

Response mapping:

- `behavior: allow` + `allowMode: session` → `{ decision: "acceptForSession" }`.
- `behavior: allow` otherwise → `{ decision: "accept" }`.
- `behavior: deny` → `{ decision: "decline" }`.
- An explicit cancellation or closed session → `{ decision: "cancel" }`.

## Data flow

1. The JSON-RPC client receives a line with `id`, `method`, and `params`.
2. It emits a server request without resolving the pending response map.
3. The Codex backend validates thread/turn scope and stores the request id.
4. It emits a normalized permission request to the existing event channel.
5. The service presents the existing permission UI.
6. The backend maps the UI response and sends a JSON-RPC result using the
   stored request id.
7. Codex emits approval resolution and item completion events.

If validation fails or the method is unsupported, the backend sends a JSON-RPC
error response. If cleanup occurs first, the pending request receives a cancel
decision and its mapping is removed.

## Error handling

- Malformed JSON remains a transport error and is logged through the existing
  client error channel.
- Unknown server-request methods receive `-32601 Method not found`.
- Unknown or stale Jean-Claude request ids throw a clear backend error.
- A failed response write terminates the client through the existing transport
  failure path.
- Session disposal cancels unresolved approvals so no UI request remains live.

## Security

- Approval payloads are scoped to the active Codex thread and turn.
- The existing permission broker remains the authority for user decisions.
- No raw command or file path is executed by Jean-Claude as part of routing.
- Approval payloads are persisted through the existing raw notification path;
  no new secret fields are introduced.

## Test strategy

- JSON-RPC client: classify server requests, preserve numeric/string ids, send
  success/error responses, and retain existing response handling.
- Codex backend: emit normalized command/file approval events, map allow/deny
  responses, reject unsupported request methods, and cancel pending requests
  during cleanup.
- Regression: ordinary notifications and `turn/start` responses continue to
  work unchanged.

## Rollout & rollback

No migration or feature flag is needed. The change is backward-compatible with
older app-server versions that only emit notifications and responses. Revert
the transport/backend changes together if approval payloads differ from the
installed Codex CLI schema.

## Open risks

- The exact approval response field name may vary between app-server schema
  revisions; tests should use the current documented `decision` payload.
- Project/worktree permission persistence is handled by Jean-Claude's existing
  broker, while Codex's protocol-level response only has turn/session scopes.
