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

## Revision 2026-10-03: read-only shell instead of inlining

Inlining the transcript hit a hard Codex limit: `turn/start` rejects input over
1,048,576 characters (counted in characters, not UTF-8 bytes — verified against
codex-cli 0.155.0), so a 1.1M-character step failed before reaching the model.
Truncating the middle was rejected: the dropped region holds the mid-run
failures and abandoned approaches the summary exists to carry forward, and the
resulting partial summary is persisted and fed into the next step unmarked.

The user chose to grant the isolated runner read-only shell instead, so it reads
the spilled transcript itself and nothing is inlined or dropped at any size.
Codex exposes no scoped Read tool — a "read" is a shell command the normalizer
relabels — so file access cannot be narrowed to one path the way Claude Code's
`allowedToolPatterns` does. The accepted tradeoff is therefore filesystem-wide
read within the read-only sandbox, opted into per call via `allowReadOnlyShell`
and used only by step summaries. Mitigations: shell is the only re-enabled
feature, `shell_environment_policy.inherit="none"` keeps process env (API keys,
tokens) out of the granted shell, `--cd` is the transcript's temp directory, and
the sandbox stays read-only with user config, rules, MCP, hooks and web search
still disabled. Residual risk: injected transcript text could instruct the model
to read an unrelated readable file and echo it into the summary; the summary
itself is the exfiltration channel, so this is not fully mitigated.

## Error handling and diagnostics

Reject unsupported CLI flags, nonzero exits, malformed output and failed turns.
Never retry through unrestricted generation. Existing step errors retain step
and backend context. Log model, input length, duration and exit status without
transcript content. Never silently truncate history: a prompt over the Codex
character limit is rejected with an actionable error, and oversized transcripts
are read from disk rather than shortened.

## Verification and rollout

Test long transcripts including middle content, cleanup after errors, no-tools
routing, CLI isolation arguments, structured output, nonzero exit and abort.
Also test that shell stays disabled without `allowReadOnlyShell`, that opting in
re-enables only shell and keeps the other restrictions, and that an oversized
prompt is rejected before spawning.
Run install, tests, lint fix, TypeScript and final lint as required by AGENTS.md.
Manual check: retry Continue new step on the original long Codex step.
No flag or migration; rollback the summary routing and runner together.
