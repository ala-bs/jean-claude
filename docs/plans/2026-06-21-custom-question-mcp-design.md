# Custom Question MCP Design

**Goal:** Make Jean-Claude own agent question/answer handling through a standard per-session MCP tool, while keeping the existing inline question UI in each task/step message stream.

**Non-goals:**
- No global question modal.
- No prompt steering for now.
- No hard deny of native question tools.
- No changelog update.

---

## Decisions

- Use a Jean-Claude MCP server as the canonical question path.
- Start session-scoped MCP for backends that support runtime MCP directly.
- Codex is out of scope until its app-server can provide per-thread MCP context or per-thread MCP config.
- Keep question rendering inline in the task/step message stream.
- Support multiple questions per request.
- Support single choice, multi choice, and free text.
- Return plain text summary to the agent.
- Keep structured answers internally for UI and routing.
- Remove native question tools from backend tool lists only when the SDK exposes a real tool-filtering API.
- Leave existing native question handlers in place as compatibility fallback.

---

## Architecture

Add a `QuestionBrokerService` in the Electron main process. It owns pending question requests, maps MCP calls to normalized Jean-Claude question events, waits for renderer answers, and returns plain text to the MCP server.

Flow:

1. Agent calls JC MCP `ask_question`.
2. MCP server forwards request to `QuestionBrokerService`.
3. Broker emits existing normalized `question` event for the active task step.
4. Renderer shows current inline `QuestionOptions` UI.
5. User answers inline.
6. Existing response IPC calls back into agent service.
7. Agent service resolves broker request.
8. MCP tool returns plain text summary to agent.

The broker should be backend-agnostic. Backends only need to attach per-session MCP config and route answers to broker-backed requests.

---

## MCP Tool Contract

Tool name:

```txt
ask_question
```

Input:

```ts
{
  questions: Array<{
    id: string;
    label: string;
    type: 'single_choice' | 'multi_choice' | 'text';
    options?: Array<{
      id: string;
      label: string;
      description?: string;
    }>;
    allowOther?: boolean;
    required?: boolean;
  }>;
  stepId?: string;
}
```

Validation:

- `questions` must contain at least one item.
- `id` must be unique within request.
- choice questions need non-empty `options`, unless `allowOther` is true.
- text questions ignore `options`.
- required defaults to true.
- `stepId` is optional when the bridge can infer a single active route.
- `stepId` is required when multiple app-scoped routes are active.

Tool output:

```txt
scope: Task
details: Keep it minimal
targets: Claude Code, OpenCode
```

For multi-choice, join labels with `, `. For empty optional text answers, omit the line.

---

## Data Model

Reuse current normalized question request shape where possible:

- `NormalizedQuestionRequest`
- `NormalizedQuestion`
- `AgentQuestion`
- `QuestionResponse`

Add broker metadata internally:

```ts
{
  brokerRequestId: string;
  taskId: string;
  stepId: string;
  backendSessionId?: string;
  source: 'jc-mcp';
  questionsById: Map<string, QuestionSpec>;
  resolve: (summary: string) => void;
  reject: (error: Error) => void;
}
```

Renderer can continue keying answers by question text for now, but broker should preserve stable question IDs so later UI can move away from text-keyed answers.

---

## Session Lifecycle

Claude/OpenCode sessions get their own MCP server process. Codex does not receive the Jean-Claude MCP server for now.

Startup:

- Agent service creates broker session context for task/step.
- Backend receives `mcpServers.jean-claude-mcp`.
- Session-scoped MCP starts with direct env values for bridge URL, session/step IDs, registration ID, and bearer token.

Shutdown:

- stop session-scoped MCP server when agent session stops.
- reject pending broker questions with a clear cancellation message.
- close pending question notifications through existing task cleanup.

Route registration IDs prevent stale step cleanup from removing newer routes for the same step.

---

## Backend Integration

All backends receive JC question MCP server config.

Claude Code:

- Inject per-session MCP server into backend config.
- If SDK exposes tool filtering, remove native `AskUserQuestion`.
- Keep existing native question handling as fallback.

OpenCode:

- Inject runtime MCP server into existing runtime MCP config path.
- Pass bridge env through `/usr/bin/env` because OpenCode runtime config has no separate `env` field.
- If SDK exposes tool filtering, remove native question tool.
- Keep existing `question.asked` handler as fallback.

Codex:

- Do not inject Jean-Claude MCP.
- Codex app-server has one shared MCP config, so env cannot carry per-step route data.
- Revisit when Codex exposes per-thread MCP config, per-tool-call thread metadata, or native tool filtering.

No prompt text should instruct agents to use the MCP tool in this phase.

---

## UI

Keep current inline UI:

- `src/features/agent/ui-question-options`
- message stream question banner/card
- feed attention state `has-question`
- existing notifications

Potential UI updates:

- add free-text support if current component lacks a clean text-only path.
- support multi-question mixed types in one request.
- preserve current keyboard behavior where possible.

No new overlay or modal.

---

## Error Handling

- MCP request validation errors return tool error immediately.
- If user cancels/step stops/session stops, return a concise cancellation error.
- If renderer answer arrives for unknown request, log and ignore.
- If MCP server exits while question is pending, reject pending request.
- Native question events still flow through current fallback path.

---

## Tests

Unit tests:

- MCP input validation.
- structured answers to plain text summary.
- broker request lifecycle: create, answer, cancel.
- per-session isolation.

Backend tests:

- each backend includes JC MCP server config.
- runtime MCP config merges with user-provided MCP servers.
- native question handler still works.

Renderer tests:

- text-only question renders and submits.
- mixed multi-question request submits all required answers.
- optional empty text is allowed.

---

## Open Questions

- Exact MCP server implementation location: standalone script under `electron/services/...` vs shared backend helper.
- Whether question answers should be persisted as structured metadata beyond existing message history.
- Backend-specific APIs for removing native question tools need verification during implementation.
