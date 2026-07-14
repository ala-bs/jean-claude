# Remove GIF Size Cap Implementation Plan

> **For Claude:** Implement task-by-task with focused tests before full verification.

**Goal:** Remove fixed GIF file-size limits while retaining CPU, parser-complexity, and decoded-memory safeguards.

**Architecture:** GIF encoding remains bounded by frame, dimension, and total-pixel limits, but worker output no longer stops at 10 MiB. Local and authenticated previews no longer reject by encoded byte count; GIF scrubbing continues to enforce frame and calculated peak-memory budgets after parsing.

**Tech Stack:** React, TypeScript, Web Workers, Electron protocol streaming, Vitest.

---

### Task 1: Remove encoder output budget

**Files:**
- Modify: `src/features/common/ui-video-gif-converter/index.tsx`
- Modify: `src/features/common/ui-video-gif-converter/gif-encoder-worker.ts`
- Modify: `src/features/common/ui-video-gif-converter/gif-encoder-worker-client.ts`
- Test: converter and worker tests in same directory

1. Update tests to expect encoding above 10 MiB to continue.
2. Remove `maxBytes`, over-budget worker responses, final output assertion, warning, and budget meter.
3. Keep estimated output range and all work limits.
4. Run focused converter tests.

### Task 2: Remove fixed preview and proxy byte caps

**Files:**
- Modify: `src/hooks/use-image-preview-urls.ts`
- Modify: `electron/services/azure-image-proxy-service.ts`
- Modify: `shared/media-limits.ts`
- Test: corresponding hook and proxy tests

1. Update tests for GIF previews and proxy streams above old limits.
2. Allow GIF Blob preview decoding without fixed byte rejection while retaining image attachment limits for normal file selection.
3. Remove fixed byte checks from streaming and base64 Azure fetches; preserve cancellation, host validation, redirect validation, and streaming backpressure.
4. Run focused tests.

### Task 3: Replace scrubber source cap with memory validation

**Files:**
- Modify: `src/features/agent/ui-markdown-content/gif-decoder-limits.ts`
- Modify: `src/features/agent/ui-markdown-content/gif-binary-preflight.ts`
- Modify: `src/features/agent/ui-markdown-content/gif-decoder-core.ts`
- Modify: `src/features/agent/ui-markdown-content/gif-frame-decoder.ts`
- Test: corresponding GIF decoder tests

1. Remove fixed source-byte assertions from tests and implementation.
2. Keep frame count, canvas pixels, frame patch pixels, block records, extension blocks, retained-frame memory, and estimated-peak memory checks.
3. Keep abort-aware chunk reading and worker cancellation.
4. Run focused decoder tests.

### Task 4: Full verification

1. Run `pnpm install`.
2. Run `pnpm test`.
3. Run `pnpm lint --fix`.
4. Run `pnpm ts-check`.
5. Run `pnpm lint` and `git diff --check`.
