# Project terminal clear shortcut — Design
Date: 2026-11-11

## Problem
The project terminal does not handle ⌘K, so users cannot clear its output with the familiar terminal shortcut. Its main-process replay buffer would restore cleared output when the pane reopens.

## Users & success criteria
In a focused project terminal, ⌘K clears the visible terminal output and scrollback, drops retained output for that session, and sends Ctrl+L to the running shell. The shell and its current directory remain intact. Output produced afterward remains visible and replays on reopen.

## Codebase findings
| Finding | Evidence |
| --- | --- |
| The project terminal uses xterm and forwards input to a persistent PTY. | `src/features/project/ui-project-terminal/index.tsx`, `electron/services/terminal-service.ts` |
| The main process retains bounded output and monotonic stream offsets for replay. | `electron/services/terminal-service.ts`, `shared/terminal-types.ts` |
| The running-command overlay already binds ⌘K. | `src/features/run-commands/ui-running-commands-overlay/index.tsx` |
| Keyboard dispatch is capture-phase and uses last registered binding first. | `src/common/context/keyboard-bindings/index.tsx` |

## Decisions
| # | Decision | Chosen | Why | Rejected alternatives |
| --- | --- | --- | --- | --- |
| 1 | Clear behavior | Clear terminal history and send Ctrl+L | User requested both, including logs. | Only clearing the view; only sending Ctrl+L. |
| 2 | Scope | Handle ⌘K only when xterm input is focused | Keeps the running-command overlay binding and other focus targets intact. | Global shortcut. |
| 3 | Replay | Drop main-process backlog and pending output without resetting stream offsets | Prevents old output returning while preserving replay deduplication. | Renderer-only clear; reset offsets. |

## In scope (v1)
Project terminal ⌘K shortcut, atomic session clear and Ctrl+L write, replay-safe renderer clear, shortcut documentation, targeted service tests.

## Out of scope
Other terminal shortcuts, command log overlay changes, shell restart, clearing shell command history.

## Architecture
```
Focused xterm ──⌘K──► useCommands ──► preload IPC ──► TerminalService.clear
    ▲                                                   │
    └──── local clear + filtered output ◄── offset ────┘
                                                        └──► PTY.write(Ctrl+L)
```

## Data flow
1. The focused terminal handles ⌘K and starts queuing incoming chunks.
2. `TerminalService.clear` discards retained and pending output, keeps the current offset, writes Ctrl+L to the live PTY, and returns the offset.
3. The renderer clears xterm and replays queued chunks only after that offset.
4. On failure, queued output is restored and the failure is logged.

## Data model / migrations
No persistent data or migration. `TerminalSession.totalChars` stays monotonic.

## Interfaces
- `TerminalService.clear(sessionId: string): number`: returns the output stream offset at the clear boundary; absent sessions return zero.
- `api.terminal.clear(sessionId: string): Promise<number>` via `project:terminal:clear`.
- ⌘K handler in `ProjectTerminal` returns `false` outside its xterm input.

## Error handling
Missing or exited sessions cannot receive Ctrl+L. A failed IPC leaves queued output visible and logs the error. Clear requests are serialized in the renderer.

## Security
The IPC accepts only a session ID already used by the terminal service. No shell command string is constructed; Ctrl+L is a fixed control character.

## Test strategy
Service tests cover retained backlog removal, pending output cancellation, monotonic offsets, and forwarding Ctrl+L. Run repository test, lint, and TypeScript checks; manually verify focus and reopening behavior in the app.

## Rollout & rollback
No flag or migration. Revert the shortcut and IPC method if needed.

## Open risks
Full-screen terminal programs may choose their own response to Ctrl+L, as with a physical Ctrl+L keypress.
