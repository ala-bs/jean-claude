# Codex Server Interactions — Design

Date: 2026-09-20

## Problem

The Codex app-server can send structured user-input and permission-profile
requests, and accepts follow-up input through `turn/steer`. Jean-Claude's
Codex adapter currently handles command/file approvals but drops these newer
server requests and cannot steer an active Codex turn.

## Decisions

| # | Decision | Chosen | Why |
|---|---|---|---|
| 1 | Question UI | Reuse `NormalizedQuestionRequest` | Existing renderer queue, persistence, and response validation already support it. |
| 2 | Permission-profile UI | Reuse `NormalizedPermissionRequest` | Existing permission bar handles pending requests and turn/session responses. |
| 3 | Profile approval payload | Grant the requested Codex profile; scope maps to turn/session | The app-server response requires the granted profile and scope, unlike command approval's decision enum. |
| 4 | Active follow-up | Implement `AgentBackend.sendUserMessage` with `turn/steer` | The provider capability already uses this seam for live follow-ups. |
| 5 | Steering eligibility | Advertise Codex `promptSteering` support and use it while a turn is active | The current queue path only attempts live input after a completed turn with background work, so Codex steering was unreachable. |
| 6 | Mode change | Persist the new mode and apply it when the next turn starts; do not steer across a mode change | Codex applies sandbox/approval settings at turn start, so steering an old turn would retain the old mode. |
| 7 | Jean-Claude MCP | Keep Jean-Claude MCP out of Codex for now | The current app-server protocol loads configured MCP servers from Codex configuration; `thread/start` does not accept the runtime server map used by Jean-Claude. Per-session support would require a separate dynamic-tool or isolated-config design. |
| 8 | Codex collaboration mode | Send native `turn/start.collaborationMode` for every new turn | The UI's Plan/Build labels must select Codex's built-in `plan`/`default` behavior, not only change the sandbox. Ask uses Codex's `default` collaboration mode with Jean-Claude's approval policy. |

## Architecture

```text
Codex app-server
      │ JSON-RPC server request
      ▼
CodexBackend pending request maps
      ├─ item/tool/requestUserInput ──► AgentEvent.question ──► existing question UI
      ├─ item/permissions/requestApproval ─► AgentEvent.permission ─► existing permission UI
      └─ AgentBackend.sendUserMessage ──► turn/steer ──► active Codex turn
```

Active prompt decision:

```text
new prompt
    │
    ├─ promptSteering supported + same mode/model/effort
    │       └─ turn/steer
    └─ otherwise
            └─ existing stop/restart or queue path
```

Codex turn mode:

```text
Jean-Claude mode     collaborationMode.mode     safety settings
Build                default                    workspace-write + auto approval
Ask                  default                    workspace-write + on-request
Plan                 plan                       read-only + on-request
```

## Interfaces

- `CodexBackend.respondToQuestion(sessionId, requestId, answers, metadata)`
  responds with `{ answers: { [questionId]: { answers: string[] } } }`.
- `CodexBackend.respondToPermission(...)` responds to permission-profile
  requests with `{ permissions, scope }`; denial sends an empty profile.
- `CodexBackend.sendUserMessage(sessionId, parts)` calls `turn/steer` with
  `threadId`, `expectedTurnId`, and the existing Codex input conversion.

## Failure handling

- Requests missing thread, turn, item, or question identifiers receive JSON-RPC
  `-32602`.
- Unknown server request methods receive `-32601`.
- Pending requests are resolved with an empty/cancel response during cleanup so
  the app-server is not left blocked.
- A steer without an active turn returns `false`, allowing the existing caller
  to fall back to its restart behavior.
- A mode change makes live steering ineligible; the caller restarts so the next
  `turn/start` receives the persisted mode.

## Test strategy

- Normalize Codex questions into single-choice and text UI questions. Codex's
  current app-server schema does not expose multi-select questions.
- Verify question answers are converted to Codex's answer-array payload.
- Verify permission-profile requests emit a permission event and respond with
  requested permissions and turn/session scope.
- Verify `turn/steer` uses the active turn ID and input conversion.
- Verify each new Codex turn receives the matching native collaboration mode;
  Plan must send `mode: "plan"` and Build/Ask must send `mode: "default"`.
- Verify malformed and cleanup paths do not leave pending requests unresolved.
