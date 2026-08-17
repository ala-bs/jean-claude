# Eurecia API Recorder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reproducible Playwright tooling that records user-driven Eurecia browser traffic for API research.

**Architecture:** A visible persistent Chromium context opens `EURECIA_URL` and performs no later page actions. Playwright writes a full HAR while a page listener records WebSocket frames; a sanitizer then emits a reviewable report with auth material redacted.

**Tech Stack:** Node.js 20, Playwright, Vitest

---

### Task 1: Capture Sanitizer

**Files:**
- Create: `scripts/eurecia-api-recorder/sanitize-capture.mjs`
- Test: `scripts/eurecia-api-recorder/sanitize-capture.test.ts`

1. Write tests covering URL, header, JSON payload, and WebSocket frame redaction.
2. Run `pnpm vitest run scripts/eurecia-api-recorder/sanitize-capture.test.ts`; expect failure because module does not exist.
3. Implement recursive sensitive-key and credential-value redaction while retaining safe scalar samples.
4. Re-run focused test; expect pass.

### Task 2: Playwright Recorder

**Files:**
- Create: `scripts/eurecia-api-recorder/record.mjs`
- Create: `scripts/eurecia-api-recorder/README.md`
- Modify: `package.json`
- Modify: `.gitignore`

1. Add Playwright development dependency and `eurecia:record` command.
2. Launch persistent visible Chromium, navigate once to `EURECIA_URL`, and record full HAR plus WebSocket frames.
3. Wait for terminal Enter before closing context and generating sanitized report.
4. Ignore profile and all capture artifacts under `.local/eurecia-recorder/`.
5. Document command, lifecycle, output paths, and sensitive-data warning.

### Task 3: Verification

**Files:**
- Review all files above.

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Inspect final diff and confirm no capture or credential artifact is tracked.
