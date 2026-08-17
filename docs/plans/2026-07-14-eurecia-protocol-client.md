# Eurecia Protocol Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a write-safe internal client that parses Eurecia timesheet forms, prepares dry-run save/approval requests, and encodes/decodes captured DWR lookup traffic without sending writes.

**Architecture:** A pure protocol module parses server-rendered HTML into ordered successful form controls, applies explicit row/action overrides, and returns a prepared multipart request plus value-free summary. A strict DWR codec emits captured plain-call envelopes and parses JSON-compatible callback payloads without evaluating JavaScript.

**Tech Stack:** TypeScript, Cheerio, Vitest

---

### Task 1: Timesheet Form Parser

**Files:**
- Create: `electron/services/timesheet-adapters/eurecia-protocol-client.ts`
- Test: `electron/services/timesheet-adapters/eurecia-protocol-client.test.ts`

1. Add synthetic HTML tests covering hidden fields, selected controls, duplicate names, disabled fields, and form metadata.
2. Run focused test and confirm failure.
3. Implement ordered successful-control parsing with no captured customer data.
4. Run focused test and confirm pass.

### Task 2: Dry-Run Request Preparation

**Files:**
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.ts`
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.test.ts`

1. Add tests for row-control overrides, duplicate preservation, transient action cleanup, save `validate=2`, and approval submission `validate=4`.
2. Implement preparation returning URL, ordered fields, and value-free summary only; add no send method.
3. Verify fresh CSRF/form-instance fields are required.
4. Run focused test and confirm pass.

### Task 3: DWR Codec

**Files:**
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.ts`
- Modify: `electron/services/timesheet-adapters/eurecia-protocol-client.test.ts`

1. Add synthetic tests for plain-call encoding, boolean callbacks, option tuples, null option lists, and executable payload rejection.
2. Implement strict typed parameter encoding and JSON-only callback parsing without `eval`.
3. Run focused test and confirm pass.

### Task 4: Verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint`.
6. Review for accidental network writes, captured personal data, and unsafe JavaScript evaluation.
