# Mobile Preview Network Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Network tab to mobile preview that captures device traffic without requiring app code changes.

**Architecture:** Start with a local HTTP proxy in the Electron main process. Jean-Claude records full HTTP request/response data and HTTPS CONNECT metadata, forwards traffic to the real destination, and can auto-configure Android emulator proxy settings. HTTPS decryption and certificate install/trust come later.

**Tech Stack:** Electron main process, Node `http`, IPC/preload bridge, React Query/hooks, React UI, Vitest.

---

## Capture Strategy

**MVP: no-code local proxy**
- Captures full HTTP requests/responses
- Captures HTTPS CONNECT host/status/timing metadata
- Works with Expo, bare React Native, iOS, Android, native apps
- Android emulator proxy can be auto-configured with `adb`
- iOS simulator and physical devices start with manual proxy instructions
- Does not decrypt HTTPS until CA generation/install/trust is added

**Next: trusted CA / MITM**
- Generate local CA
- Install/trust on iOS simulator automatically where possible
- Guide Android/iOS physical device trust
- Decrypt HTTPS except apps with certificate pinning

**Later: RN DevTools / CDP bridge**
- Open official RN DevTools
- Spike private protocol ingestion only if stable enough

---

### Task 1: Shared Network Types

**Files:**
- Modify: `shared/mobile-simulator-types.ts`

**Step 1: Add types**

Add:

```ts
export type MobilePreviewNetworkCaptureStatus =
  | 'stopped'
  | 'running'
  | 'errored';

export type MobilePreviewNetworkRequest = {
  id: string;
  sessionId: string;
  method: string;
  url: string;
  status: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  responseBodyPreview: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: string | null;
  source: 'fetch' | 'xhr';
};

export type MobilePreviewNetworkCaptureSession = {
  id: string;
  projectPath: string;
  appPath: string;
  status: MobilePreviewNetworkCaptureStatus;
  port: number;
  ingestUrl: string;
  androidEmulatorIngestUrl: string;
  lanIngestUrls: string[];
  error: string | null;
  updatedAt: string;
};

export type MobilePreviewNetworkCaptureStartParams = {
  projectPath: string;
  appPath: string;
  port?: number;
};

export type MobilePreviewNetworkCaptureEvent = {
  sessionId: string;
  request: MobilePreviewNetworkRequest;
};

export type MobilePreviewNetworkCaptureSessionEvent = {
  session: MobilePreviewNetworkCaptureSession;
};
```

**Step 2: Run typecheck**

Run: `pnpm ts-check`

Expected: pass or only missing API wiring from later tasks if implemented out of order.

---

### Task 2: Main-Process Capture Server

**Files:**
- Create: `electron/services/mobile-preview-network-capture-service.ts`
- Create: `electron/services/mobile-preview-network-capture-service.test.ts`

**Step 1: Write tests first**

Cover:
- Starts HTTP server on requested port or random port
- Returns `ingestUrl`, `androidEmulatorIngestUrl`, LAN URLs
- Accepts `POST /network-events`
- Rejects invalid JSON with `400`
- Emits one event per posted request
- Stops server idempotently

**Step 2: Implement service**

Use Node `http`, no new dependency.

Server behavior:
- `POST /network-events`
  - body shape: `{ sessionId: string, requests: MobilePreviewNetworkRequest[] }`
  - enforce current session id
  - cap request body size, e.g. 1 MB
  - emit each request to listeners
- `GET /health`
  - returns `200 ok`

Session URLs:
- `ingestUrl`: `http://127.0.0.1:<port>/network-events`
- `androidEmulatorIngestUrl`: `http://10.0.2.2:<port>/network-events`
- `lanIngestUrls`: first few IPv4 LAN addresses from `os.networkInterfaces()`

**Step 3: Run targeted tests**

Run:

```bash
pnpm test -- electron/services/mobile-preview-network-capture-service.test.ts
```

Expected: pass.

---

### Task 3: IPC And API Wiring

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Step 1: Add IPC handlers**

Channels:
- `mobilePreview:startNetworkCapture`
- `mobilePreview:stopNetworkCapture`

Forward events to all windows:
- `mobilePreview:networkCaptureSession`
- `mobilePreview:networkCaptureRequest`

**Step 2: Add preload methods**

Expose:
- `api.mobilePreview.startNetworkCapture(params)`
- `api.mobilePreview.stopNetworkCapture(sessionId)`
- `api.mobilePreview.onNetworkCaptureSession(callback)`
- `api.mobilePreview.onNetworkCaptureRequest(callback)`

**Step 3: Add renderer API types and fallback**

Update `Api['mobilePreview']` in `src/lib/api.ts`.

Fallback:
- `startNetworkCapture` throws `API not available`
- `stopNetworkCapture` no-op
- subscriptions return no-op unsubscribe

**Step 4: Run checks**

Run:

```bash
pnpm ts-check
pnpm test -- electron/services/mobile-preview-network-capture-service.test.ts
```

Expected: pass.

---

### Task 4: Renderer Hook

**Files:**
- Modify: `src/hooks/use-mobile-preview.ts`

**Step 1: Add hook**

Create `useMobilePreviewNetworkCapture(params)` next to Metro/native log hooks.

Behavior:
- state: `session`, `requests`, `error`
- subscribes to session/request events
- filters by current session id
- caps retained requests, e.g. last 500
- stops active capture on unmount/params change
- exposes `start`, `stop`, `clear`, `isStarting`, `isStopping`

**Step 2: Add tests if hook test harness exists**

If no hook harness exists, rely on service tests + typecheck.

**Step 3: Run typecheck**

Run: `pnpm ts-check`

Expected: pass.

---

### Task 5: App-Side Capture Snippet Generator

**Files:**
- Create: `src/features/task/ui-task-panel/mobile-preview-pane/network-capture-snippet.ts`
- Test: `src/features/task/ui-task-panel/mobile-preview-pane/network-capture-snippet.test.ts`

**Step 1: Generate snippet text**

Export:

```ts
export function buildNetworkCaptureSnippet({
  ingestUrl,
  sessionId,
}: {
  ingestUrl: string;
  sessionId: string;
}): string;
```

Snippet requirements:
- dev-only guard: `if (typeof __DEV__ !== 'undefined' && __DEV__)`
- idempotent guard: `globalThis.__JEAN_CLAUDE_NETWORK_CAPTURE__`
- wraps `globalThis.fetch`
- wraps `globalThis.XMLHttpRequest`
- sends batches to `ingestUrl`
- uses original XHR for upload with recursion guard
- truncates body previews to 32 KB
- catches all instrumentation errors

**Step 2: Test snippet content**

Tests should assert:
- includes provided `sessionId`
- includes provided `ingestUrl`
- includes `fetch` and `XMLHttpRequest`
- includes idempotent guard
- includes `__DEV__`

**Step 3: Run targeted tests**

Run:

```bash
pnpm test -- src/features/task/ui-task-panel/mobile-preview-pane/network-capture-snippet.test.ts
```

Expected: pass.

---

### Task 6: Network Tab UI

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Step 1: Add `network` tab**

Change:

```ts
type MobilePreviewPaneTab = 'preview' | 'metro' | 'logs' | 'network';
```

Add tab to segmented control.

**Step 2: Start/stop capture panel**

Network tab header:
- status
- selected ingest URL
- Start/Stop button
- Clear button

If no capture running:
- show install snippet/instructions
- show URL choices:
  - iOS simulator: `127.0.0.1`
  - Android emulator: `10.0.2.2`
  - physical device: LAN URL

**Step 3: Request list**

Render compact table:
- method
- status
- duration
- URL
- source

Row details:
- request headers
- response headers
- request body preview
- response body preview
- error

**Step 4: Copy snippet**

Add button:
- copies generated snippet
- label: `Copy snippet`

Do not auto-edit user project files in MVP.

**Step 5: Run typecheck**

Run: `pnpm ts-check`

Expected: pass.

---

### Task 7: Final Verification

**Files:**
- No new files

**Step 1: Install**

Run: `pnpm install`

Expected: pass. Existing Node engine warning is acceptable in this worktree.

**Step 2: Test**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Lint fix**

Run: `pnpm lint --fix`

Expected: pass or auto-fix formatting.

**Step 4: Typecheck**

Run: `pnpm ts-check`

Expected: pass.

**Step 5: Final lint**

Run: `pnpm lint`

Expected: pass.

---

## Non-MVP Follow-Ups

- Native proxy capture with device proxy config and HTTPS cert install
- React Native DevTools/CDP spike
- HAR export
- search/filter by host, method, status, text
- "send request details to focused task"
- correlate network requests with selected preview timestamp
