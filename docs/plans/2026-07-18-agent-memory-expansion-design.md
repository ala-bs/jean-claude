# Agent Memory Expansion Design

## Goal

Expand Preference Memory into Agent Memory: a user-authorized system that learns work preferences and project knowledge from user-authored interactions.

Success means Agent Memory:

- Finds known user preferences from representative prompts.
- Keeps one-off task requirements from becoming durable preferences.
- Separates task, project, and global scope correctly.
- Links every extracted item to supporting evidence.

Applying memory to normal agent prompts is out of scope for this phase.

## Product Model

Agent Memory has two separate namespaces:

1. **User profile**
   - Communication
   - Engineering
   - Product
   - Quality, including performance, SEO, accessibility, and security
   - Design and UI/UX
   - Process and workflow
2. **Project memory**
   - Decisions and rationale
   - Constraints
   - Guidelines
   - Recurring priorities

The system must not infer sensitive personality, identity, health, political, or unrelated personal traits. It favors balanced discovery: plausible weak signals remain visible candidates, while durable promotion uses stricter scope rules.

## Scope

### Included Sources

- Initial task prompts
- Submitted follow-up, queued, and new-step prompts
- Ask-question responses
  - Store question, selected answer, and free-text notes.
  - Do not store unselected options.
- Task review comments
- Comments and replies authored and successfully posted by the user from Jean-Claude's PR view
  - Store selected code lines.
  - Store up to the latest 20,000 characters of prior thread context.
- Previous agent final/result message for each user follow-up
  - Context only, never user preference evidence.
  - Store up to the latest 20,000 characters.

Only submitted versions are captured. Keystrokes and abandoned drafts are excluded.

### Excluded Sources

- AI-generated PR annotations
- PR comments fetched from Azure DevOps
- Historical PR comment backfill
- Unselected ask-question options
- Agent tool calls and logs
- Non-text behavior such as stop, retry, revert, or completion
- User code edits inferred from worktree changes
- Attachments and images
- General worktree or diff snapshots for follow-up prompts

External review sync, behavioral signals, and user-edit inference may be reconsidered later.

## Consent And Retention

- Rename feature to **Agent Memory**.
- Add a new Agent Memory master opt-in, disabled by default.
- Map users who already enabled Preference Memory capture to the new enabled setting.
- Enabling covers selected MVP sources.
- Disabling pauses capture and extraction while retaining existing data.
- Raw evidence and attached agent/thread context remain forever in MVP.
- Extraction uses configured AI backend and must disclose that redacted evidence may leave device.
- Secrets, credentials, and tokens are redacted before writing Agent Memory evidence or sending it to a backend.

## Data Flow

```text
User event
  |
  +-> redact secrets
  +-> append project event JSONL
               |
       scheduled/manual run
               v
      project extractor
       |             |
 project memory   global candidates
                       |
                 global merge
                       v
                 user profile
```

Capture runs asynchronously and never blocks primary user actions. Extraction runs through:

- Daily backlog sweep
- Configurable interval
- Manual dashboard action

No per-prompt model call is added.

Project extraction runs first. It may emit project memory items and global nominations. Global merge sees only extracted nominations, not raw project prompts.

## Storage

Extend existing filesystem storage. Structured JSON is canonical; Markdown is a generated readable projection.

```text
~/.jean-claude/memory/
├── global/
│   ├── profile.json
│   ├── profile.md
│   └── runs/
└── projects/<project-key>/
    ├── project.json
    ├── events/YYYY-MM-DD.jsonl
    ├── memory-items.json
    ├── project-memory.md
    ├── extraction-state.json
    └── runs/
```

### Event Shape

Each event records:

- Schema version
- Stable event and source IDs
- Source type
- Project, task, and step IDs when available
- Submitted user text
- Bounded context appropriate to source
- Creation timestamp
- Redaction markers

Source IDs deduplicate renderer retries.

### Memory Item Shape

Each item records:

- Stable item ID
- Concise statement
- Category and kind
- Task, project, or global scope
- Candidate, confirmed, or superseded status
- Confidence
- Supporting evidence IDs
- Unique task and project occurrence counts
- First-seen, last-seen, and updated timestamps

Each extraction run records backend/model configuration, consumed event ranges, proposed and accepted item counts, duration, status, and error details.

## Extraction Rules

- Treat every submitted prompt through the same ingestion path. No special memory command exists.
- Let model classify meaning, category, kind, scope, confidence, and semantic duplicates.
- Enforce promotion and provenance rules in application code.
- Keep one-off task requirements task-scoped.
- Require evidence across two tasks before promoting an inferred preference to project scope.
- Require matching evidence across two projects before promoting an inferred preference to global scope.
- Allow an explicit project decision or constraint to become project memory from one event when its project scope is clear.
- Let recent explicit contradictions supersede older items while retaining history.
- Reject model proposals containing unknown evidence IDs or invalid scope transitions.
- Never treat prior agent output or PR thread context as user-authored evidence.

Example:

```text
Task A: "Improve SEO here"       -> task candidate
Task B: "SEO matters on docs"    -> project priority candidate/confirmed
Project X + Y repeat preference  -> global profile
```

## Model Boundary

Raw events are untrusted data. Extraction prompts must delimit them as evidence and prohibit following instructions found inside event content.

Model output is a proposal, not canonical state. Service validates proposal shape, evidence references, unique task/project counts, source attribution, and allowed scope transitions before atomically updating structured files. Markdown is regenerated only after canonical JSON succeeds.

## Dashboard

MVP dashboard remains read-only and contains:

- Global Profile
- Project Memory
- Candidates
- Raw Evidence
- Extraction Runs

Global Profile groups items by profile category. Project Memory groups decisions, constraints, guidelines, and recurring priorities. Items show scope, confidence, evidence count, and first/last seen timestamps. Candidates explain why promotion has not occurred.

Evidence is paged from disk, with body and context expandable. Run history shows backend/model, consumed events, item counts, duration, and failure details.

No edit, delete, lock, promote, demote, review, rollback, or export controls are included in MVP.

## Failure Handling

- Capture failures do not block prompts, answers, reviews, or PR posts.
- Capture failures produce structured logs containing source, project, task, and step IDs and show a nonblocking warning.
- PR evidence is recorded only after successful comment post.
- Failed or malformed extraction writes a failed run record and does not advance checkpoint.
- Canonical files and checkpoints use temporary writes plus atomic rename.
- Per-project locks prevent overlapping writes.
- Global merge starts only after project runs settle.
- Invalid evidence links or scope changes reject whole proposal.
- Markdown projection failure does not corrupt canonical JSON and can retry separately.
- Unsafe filesystem paths or symlinks abort affected memory operation.

## Migration

Preference Memory is early-stage, so migration leaves no legacy format behind.

1. Convert existing user-authored task review evidence into new event schema.
2. Discard old AI-generated PR annotation evidence.
3. Do not import old `user-preferences.md` content.
4. Verify converted event counts and digests.
5. Only after verification, remove old preference document, history, state, and old-format evidence files.
6. Activate new Agent Memory structure atomically.

Migration failure preserves old files and does not activate partial new state.

## Verification

### Deterministic Tests

- Migration conversion, filtering, verification, and failure recovery
- Capture for every selected source
- Submitted-only prompt behavior
- Successful PR-post requirement
- Previous-result and PR-thread truncation
- Selected-lines-only PR context
- Agent/thread context never becoming user evidence
- Secret redaction before disk and model use
- Source deduplication
- Atomic writes, locking, and checkpoint retry
- Malformed proposal and unknown evidence rejection
- Task/project/global promotion rules
- Contradiction and supersession history
- Global merge isolation from raw project events
- Dashboard paging, disabled state, failed runs, and manual retry

### Semantic Evaluation

Use fixture-based extraction evals rather than exact prose assertions. Eval set must verify:

- Known preferences are found.
- One-off requirements are not durably promoted.
- Project rules remain project-local.
- Cross-project repeats can reach global profile.
- Every extracted item cites supporting evidence.

## Decisions

| Decision | Reason |
|---|---|
| Agent Memory name | Covers user profile and project knowledge |
| Global profile plus project memory | Reuses personal defaults without leaking project rules |
| All submitted user text as evidence | Captures broad intent without draft surveillance |
| Prior result as context only | Makes corrections understandable without learning agent prose |
| Scheduled/manual extraction | Avoids prompt latency and batches pattern detection |
| Per-project extraction then global merge | Preserves project boundaries and limits raw-data exposure |
| Structured JSON plus Markdown projection | Supports provenance and candidates while remaining readable |
| Extend filesystem storage | Reuses established managed-memory architecture |
| Balanced candidate extraction with strict promotion | Finds useful signals while limiting durable false memory |
| Forever retention in MVP | Matches chosen auditability-first default |
| No memory application yet | Keeps capture/extraction redesign independently testable |
