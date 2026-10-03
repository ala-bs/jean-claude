# Codex step summaries — Design

Date: 2026-10-03

## Problem and success criteria

Continue new step spills histories over 30,000 characters to disk. The Codex
generation adapter rejects the resulting scoped Read permission, so continuation
fails before contacting the model. Both short and long Codex histories must
produce validated summaries with the selected model.

## Decisions and scope

The user chose to keep Codex and approved an isolated `codex exec` runner.
Provider switching was rejected because it changes where history is sent.
Removing restrictions from the existing shared app-server was rejected because
it would expose tools and inherited integrations to transcript content.
Other providers retain their existing file-backed path. No migrations or UI
changes are needed. General restricted file/tool access remains unsupported.

## Architecture and interfaces

```text
step service -> session summary -> generateText(toolPolicy: none)
                                      -> isolated Codex exec -> schema validation
```

The session-summary service reads its own prepared transcript into the prompt.
It requests no tools and disables provider swapping for Codex summaries.
`generateCodexWithoutTools(input)` accepts the existing generation input plus
optional outputSchema, returning parsed JSON or text. The provider adapter
routes explicit no-tool requests here; skills and nonempty tool restrictions
are rejected. Existing unrestricted generation keeps the shared app-server.

## Security and lifecycle

Use a unique temporary working directory, ignore user configuration and exec
rules, disable shell, integrations, hooks, browser, image, subagent and skill
features, and use read-only sandboxing with no approval escalation. Supply the
prompt through stdin and the schema through a temporary file. No shell command
interpolation. Keep authentication in the existing Codex home. Clean temporary
artifacts on success, failure and cancellation. Preserve the outer generation
timeout, terminate canceled children, and collect usage from JSONL events.

## Error handling and diagnostics

Reject unsupported CLI flags, nonzero exits, malformed output and failed turns.
Never retry through unrestricted generation. Existing step errors retain step
and backend context. Log model, input length, duration and exit status without
transcript content. Very large inputs can still exceed model context limits;
surface that failure rather than silently truncating history.

## Verification and rollout

Test long transcripts including middle content, cleanup after errors, no-tools
routing, CLI isolation arguments, structured output, nonzero exit and abort.
Run install, tests, lint fix, TypeScript and final lint as required by AGENTS.md.
Manual check: retry Continue new step on the original long Codex step.
No flag or migration; rollback the summary routing and runner together.
