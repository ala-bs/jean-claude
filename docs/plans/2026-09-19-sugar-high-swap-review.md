# Replace shiki with sugar-high — Review

Date: 2026-09-19

Scope: the uncommitted working diff (15 modified files, 1 deleted, 2 new). The
branch has no commits against its base, so there was no branch-vs-base diff to
review. No design or plan artifact exists for this change, so Round 2 was
limited to repo conventions.

Three rounds: 5 parallel correctness lenses → conformance → one adversarial
verifier per surviving finding plus a risk-map sweep. 11 subagents total.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | A `.ts`/`.js` file containing one unbroken 200KB+ word run (inlined data URI, `sourceMappingURL=...base64,`) froze the renderer for 2–30s with no placeholder. | sugar-high's lexer is ~quadratic in the length of a single contiguous word token. Highlighting moved onto the synchronous render path with no size guard, and inputs over `MAX_CACHEABLE_ENTRY_CHARS` are never cached, so the cost repeated on every remount. | Detect a word run over `MAX_WORD_RUN_CHARS` (32K) in one cheap `charCodeAt` pass and degrade to uncoloured text. Guards both `tokenizeLines` and `highlightToHtml`. Predicate chosen by measurement: run length, not line or file size, because real base64 (49ms/200KB) and minified JS (100ms/200KB) are fast and must stay highlighted. | `src/lib/syntax-highlight.ts` |
| 2 | Medium | In any CRLF file, the last visible character of every line rendered in string-colour instead of its own. | sugar-high merges a trailing `\r` into the preceding token and types the merged token `string`. | Normalize `\r\n` before `parse()`, then re-attach `\r` as its own uncoloured token, per line (endings can be mixed, and a trailing CRLF leaves a final line with none). | `src/lib/syntax-highlight.ts` |
| 3 | Medium | `tokenizeLines('<a/</')` returned tokens rejoining to `<a</` — the diff view would display text that is not in the file, and search-highlight character offsets shifted by one after the drop point. | sugar-high silently drops a `/` when it precedes `/` or `</` inside an unclosed tag. Consumers render token content, not raw line text, and build character-offset maps from token lengths, so the module's documented content-preservation guarantee was load-bearing but only assumed. | Per-line audit: if a line's tokens do not span exactly that line's characters, fall back to one uncoloured token for that line. Loses colour on the offending line only, never correctness. Also throws on parsed-line-count drift. | `src/lib/syntax-highlight.ts` |
| 4 | Low | `src/lib/syntax-highlight.ts` registered as a **binary** file to `git diff`, `grep` and review tooling. | The cache-key separator was written as a literal NUL byte (`` `${language}\x00${code}` ``) instead of an escape. Harmless at runtime — language names contain neither NUL nor spaces, so the key was unambiguous — but it defeated text tooling. Found only because the mandatory "confirm fixes are on disk" grep returned nothing. | Replaced with an explicit `\n` escape; verified all 16 changed files are NUL-free. | `src/lib/syntax-highlight.ts` |
| 5 | Low | Two comments asserted things the review disproved. | (a) The timeline-entry comment justified having no `useMemo` by claiming `tokenizeLines` caches internally — false above 200K chars. The conclusion holds for a different reason: the React Compiler hoists the call into a cache guard keyed on `content`/`filePath`, proven by compiling the file and reading the output. (b) The module docstring cited shiki's "~175MB steady state" as the motivation; that figure was an RSS delta including oniguruma's out-of-heap WASM, and a heap-based measurement put shiki at 29.5MB. | Comment (a) now states the real mechanism; docstring (b) now states what was actually measured and flags that the two have never been compared in a real renderer heap snapshot. | `ui-timeline-entry/index.tsx`, `src/lib/syntax-highlight.ts` |

## Before / after

Highlighting path, after the fixes:

```
tokenizeLines(code, lang)
        |
        +-- cache hit? ---------------------------> return entry.lines
        |
        +-- hasPathologicalWordRun(code)? --yes--> plain uncoloured lines
        |       (word run > 32K: quadratic lexer)   [no freeze]
        |
        +-- parse(CRLF-normalized code)
        |       |
        |       +-- line count != raw line count? --> plain uncoloured lines
        |       |
        |       +-- per line:
        |             tokens + re-attached '\r'
        |                    |
        |                    +-- spans exactly raw line? --no--> plain line
        |                    |                                   [never wrong text]
        |                    +-- yes --> coloured tokens
        |
        +-- cache if <= 200K chars (charge code.length, credited back exactly)
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| Deleting the `isLoading` early return introduced stale fold ranges from the previous file, and burned the one corrective re-scroll. | The deleted `return` sat **below** the hook calls in the same component, so it never unmounted anything and never reset `foldRanges`. Hooks run unconditionally before a return. The staleness is identical in `HEAD`. Worse for the old code: `isLoading` was gated on the shiki *tokenization* promise, unrelated to the fold-range IPC promise, so the window was never covered — and it rendered the previous file's *content* too. This change strictly improves it. Real latent bug, but pre-existing and out of scope. |
| The quadratic freeze is a regression versus shiki. | shiki was ~1000x worse on identical input: 58,684ms at 50KB and 269,054ms at 100KB, versus 72ms and 221ms. Its oniguruma tokenization is synchronous WASM inside the promise and never yielded either — the old code painted a placeholder and then froze for *minutes*. The only genuine regression is the lost placeholder. |
| `xml` coverage was lost — `pom.xml` now renders flat grey. | `resolveLanguage('xml') → 'html'`. A sweep of **every** extension in the deleted `LANGUAGE_MAP` found zero regressions to plaintext. The claim's own examples were never in the old map: `.svg` and `.csproj` returned `'text'` before too. |
| An empty fenced code block now renders as an empty bordered box. | Premise false: `highlightToHtml('')` returns a real `sh__line` span, not `''`. And the deleted fallback rendered `{code}` where `code === ''` — equally empty. No-op either way. |
| The `escapeHtml` fallback not escaping quotes is an XSS hole. | It is only ever inserted as element content inside `<code>`, never into an attribute; `<` and `>` are escaped so no tag or attribute context can be opened. Separately, 21 payloads × 5 wrappers × 17 languages through `highlightToHtml` produced 0 raw-HTML leaks, and every token `color` matched `^(inherit|var\(--sh-[a-z0-9_]+\))$`. |
| `LineNumberedContent` re-parses on every render because it has no `useMemo`. | The React Compiler compiles the component successfully (`CompileSuccess`) and hoists the `tokenizeLines` call inside a cache guard keyed on `content` and `filePath` — equivalent to the `useMemo` that was removed. Established by running the real plugin and reading the emitted code, not by inference. |
| `scss`/`less` → `css` could make tree-sitter return non-empty but wrong fold ranges, silently beating the indentation fallback. | Unreachable: no tree-sitter grammar in this repo loads at all (see Not fixed), so `computeFoldRanges` always returns `[]`. |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| `MAX_CACHED_CHARS = 2_000_000` is denominated in source characters, but retained cost is ~20 bytes/char for real source (measured 39.9MB for 236 repo files at 2.0M chars) and up to ~55 bytes/char for token-dense content (110.7MB). The accounting is exact and the bound is enforced — three verifiers tried and failed to construct a drift — so this is a tuning choice, not a defect. | Leave at ~40MB realistic ceiling, or drop the budget to ~500K chars (~10MB) and accept more cache misses. | Ask. A cache ceiling is a limit, not a correctness question. I lean toward lowering it, but only a real renderer heap snapshot can say whether 40MB is materially worse than what shiki held in production — and the shiki comparison is currently unresolved (29.5MB by heap vs 174MB by RSS). |
| `getLanguageFromPath` treats an extensionless filename as a language name, so a wrapper script literally named `go`, `c`, `ts` or `python` gets that language's highlighting. Related: `.env` → `shell` but `.env.local`/`.env.production` → `plaintext`. | Keep the fallback (occasionally useful, occasionally wrong), or restrict extensionless resolution to the explicit `FILENAME_OVERRIDES` list only. | Ask. Both defensible; the collision set is tiny and the outcome is keyword colouring rather than grey. The `.env.local` gap is the more worthwhile half if you want one change. |
| Markdown fences and YAML key/value contrast are materially weaker than under shiki (accepted when the swap was approved). | Accept, or add a ~60-line custom markdown tokenizer with no new dependency. | Ask after you have looked at a real agent response. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| **Every tree-sitter grammar fails to load.** `tree-sitter-wasms@0.1.13` ships wasm with the legacy `dylink` custom section; `web-tree-sitter@0.26.8` requires `dylink.0` and throws. `electron/services/tree-sitter-fold-service.ts` swallows the error and returns `[]`, so code folding silently runs on the indentation fallback for every language. An entire subsystem is inert. | Pre-existing; neither dependency is touched by this diff. Deserves its own issue. Note that fixing it makes the `scss → css` mapping live, and `FOLDABLE_NODE_TYPES` contains no SCSS node types. |
| `foldRanges` is not reset when content or language changes, and `foldsHydratedRef` is not reset on `filePath` change, so a file switch can render the previous file's fold ranges. | Pre-existing (see Refuted). Fixing it means touching fold logic this change never went near. |
| `fs:readFile` (`electron/ipc/handlers.ts:4743`) has no `stat.size` guard, unlike `fs:readSpreadsheetAsBase64` directly below it. Unbounded file content reaches the renderer. | Pre-existing, and the in-module word-run guard now covers the freeze this diff could have caused. A size guard at the IPC boundary is the better long-term fix but is out of scope. |
| `src/lib/content-security-policy.test.ts:7` is still named "allows Shiki to compile WebAssembly" and asserts `wasm-unsafe-eval` in the renderer CSP. The assertion passes but its rationale is dead — the renderer no longer runs wasm. | Dropping `wasm-unsafe-eval` is a security hardening opportunity, not part of this change. |
| `FilePreviewPane` is now the only consumer of the main process's 35-entry `languageMap`; `getLanguageFromPath(fullPath)` in the renderer would give a better answer and remove a third language vocabulary. | Consolidation, not a defect. |

## Verification

Commands run and read, after all fixes:

- `pnpm ts-check` — clean (both `tsconfig.web.json` and `tsconfig.node.json`).
- `pnpm lint` — 0 errors.
- `pnpm test` — **5844 passed**, 1 skipped, 1 failed.
  - The single failure is `electron/database/migrations/078_pr_workspace_support.test.ts:345`,
    `client.setAuthorizer is not a function` (better-sqlite3 API). Confirmed
    pre-existing by stashing the whole change and re-running: it fails
    identically on the clean baseline.
- `src/lib/syntax-highlight.test.ts` — 32 tests, all passing. 12 were added by
  this review, each pinning a bug that was actually reproduced first:
  malformed-markup character loss (7 inputs), CRLF miscolouring, mixed
  line-ending preservation (7 inputs), and 4 word-run-guard cases including
  negative cases asserting base64 and minified content still highlight.
- Confirmed every row in **Fixes** is present on disk via `grep`, and that all
  16 changed files are NUL-free.
- Confirmed no leftover scratch files: the working tree contains exactly the
  15 modified + 1 deleted + 2 new files intended.

### Fixes applied during this review, reviewed again

Re-reading my own fix diff caught a bug I introduced while fixing #2/#3: I
"optimized" the audit to compare against sugar-high's own `line.value` rather
than re-splitting the source. That was wrong twice — `line.value` is itself
lossy on malformed markup, so it agreed with its own bad tokens and silently
disabled fix #3; and I blanket-appended `\r` to every line, corrupting the final
line after a trailing CRLF. The existing suite caught the first, a mixed-ending
probe caught the second. Both are now permanent test cases. For a few minutes the
fix was worse than the bug.
