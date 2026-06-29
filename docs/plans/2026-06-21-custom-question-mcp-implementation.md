# Custom Question MCP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add Jean-Claude-owned `ask_question` MCP flow for all agent sessions, using existing inline task/step question UI.

**Architecture:** Add a main-process question broker that turns MCP requests into existing normalized question events and resolves answers back to MCP as plain text. Extend existing Jean-Claude MCP server with `ask_question`, reachable through a per-session local bridge. Attach the MCP server to every backend session; keep native question handlers as fallback.

**Tech Stack:** TypeScript, Electron main process, MCP SDK, React, Vitest, Oxlint

---

### Task 1: Question Contract and Broker

**Files:**
- Create: `electron/services/question-broker-service.ts`
- Test: `electron/services/question-broker-service.test.ts`

**Steps:**
1. Define `QuestionSpec` union for `single_choice`, `multi_choice`, and `text`.
2. Add validation for request shape:
   - at least one question
   - unique IDs
   - choice questions need options unless `allowOther`
   - text questions ignore options
3. Add conversion to `NormalizedQuestionRequest`.
4. Add `formatAnswerSummary()` that returns plain text lines:
   - `label: value`
   - multi-choice values joined by `, `
   - omit empty optional text answers
5. Add broker lifecycle:
   - `createRequest({ taskId, stepId, questions })`
   - `answerRequest(requestId, answers)`
   - `cancelRequest(requestId, reason)`
   - `cancelSession(stepId, reason)`
6. Test validation, formatting, answer resolution, cancellation, and per-step isolation.

### Task 2: MCP Ask Question Tool

**Files:**
- Modify: `electron/mcp/jean-claude-mcp-server.ts`
- Test: `electron/mcp/jean-claude-mcp-server.test.ts` if practical, otherwise broker-level tests are acceptable.

**Steps:**
1. Add `ask_question` tool schema using existing MCP SDK + zod.
2. Accept `questions` array matching broker contract.
3. Require session routing env:
   - `JC_MCP_SESSION_ID`
   - `JC_MCP_BRIDGE_URL`
   - `JC_MCP_AUTH_TOKEN`
4. Forward tool call to broker bridge.
5. Return broker plain text summary as MCP text content.
6. Return MCP error for validation, missing session env, bridge failure, or cancellation.

### Task 3: Agent Service Integration

**Files:**
- Modify: `electron/services/agent-service.ts`
- Modify or create small helper if needed.
- Test: `electron/services/agent-service.test.ts`

**Steps:**
1. Create broker session context before backend start.
2. Add Jean-Claude question MCP config for task step types whose backend supports runtime MCP.
3. Merge question MCP config with existing review MCP config.
4. When broker emits a question request, reuse existing pending request path and inline `question` event.
5. On user answer, resolve broker request when request source is JC MCP; otherwise call existing `backend.respondToQuestion`.
6. On stop, cancel pending broker requests.

### Task 4: Backend MCP Coverage

**Files:**
- Modify tests for existing Claude/OpenCode behavior if needed.

**Steps:**
1. Confirm Claude already forwards `config.mcpServers`.
2. Confirm OpenCode already forwards runtime MCP servers.
3. Keep Codex out of the Jean-Claude MCP path for now.
4. Revisit Codex only when app-server supports per-thread MCP config or per-tool-call route metadata.
5. Do not add prompt steering.
6. Do not hard-deny native tools.

### Task 5: Inline UI Free Text

**Files:**
- Modify: `src/features/agent/ui-question-options/index.tsx`
- Test: add/update local renderer test if existing test harness supports it.

**Steps:**
1. Support questions with `options.length === 0` as text-only.
2. Keep current choice and multi-choice UI unchanged.
3. For text-only questions, render textarea directly.
4. Keep `cmd+enter` submit behavior.
5. Ensure all required questions need non-empty answers.

### Task 6: Final Verification

**Commands:**
1. `pnpm install`
2. `pnpm test`
3. `pnpm lint --fix`
4. `pnpm ts-check`
5. `pnpm lint`

**No commit.**
