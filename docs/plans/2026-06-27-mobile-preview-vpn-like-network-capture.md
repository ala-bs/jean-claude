# Mobile Preview VPN-Like Network Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Capture as much mobile app network traffic as practical without requiring app code changes.

**Architecture:** Keep the existing HTTP proxy as the primary readable capture path, then add packet-level metadata capture as a fallback for traffic that bypasses the proxy. Label every captured item by source so the UI is honest: `proxied`, `mitm`, `tunneled`, or `packet-only`.

**Tech Stack:** Electron main process, Node `http`/`net`, `adb`, `xcrun simctl`, `tcpdump` where available, React mobile preview pane, Vitest.

---

### Task 1: Define Capture Source Types

**Files:**
- Modify: `shared/mobile-simulator-types.ts`
- Test: `shared/types.test.ts`

**Step 1: Add failing type-level/runtime expectations**

Add coverage that network entries can carry `captureSource`:

```ts
expect(['proxied', 'mitm', 'tunneled', 'packet-only']).toContain('packet-only');
```

**Step 2: Extend network request type**

Add:

```ts
export type MobilePreviewNetworkCaptureSource =
  | 'proxied'
  | 'mitm'
  | 'tunneled'
  | 'packet-only';
```

Add `captureSource: MobilePreviewNetworkCaptureSource` to `MobilePreviewNetworkRequest`.

**Step 3: Run**

```bash
pnpm test shared/types.test.ts
pnpm ts-check
```

Expected: pass.

**Step 4: Commit**

```bash
git add shared/mobile-simulator-types.ts shared/types.test.ts
git commit -m "feat(mobile-preview): classify network capture sources"
```

---

### Task 2: Mark Existing Proxy Events

**Files:**
- Modify: `electron/services/mobile-preview-network-proxy-service.ts`
- Test: `electron/services/mobile-preview-network-proxy-service.test.ts`

**Step 1: Write failing tests**

Assert:
- plain HTTP request emits `captureSource: 'proxied'`
- CONNECT tunnel emits `captureSource: 'tunneled'`
- MITM request emits `captureSource: 'mitm'`

**Step 2: Implement minimal source assignment**

In proxy emit paths, add:

```ts
captureSource: session.enableMitm ? 'mitm' : 'proxied'
```

For CONNECT-only tunnel metadata:

```ts
captureSource: 'tunneled'
```

**Step 3: Run**

```bash
pnpm test electron/services/mobile-preview-network-proxy-service.test.ts
pnpm ts-check
```

Expected: pass.

**Step 4: Commit**

```bash
git add electron/services/mobile-preview-network-proxy-service.ts electron/services/mobile-preview-network-proxy-service.test.ts
git commit -m "feat(mobile-preview): label proxy network events"
```

---

### Task 3: Add Packet Capture Service Shell

**Files:**
- Create: `electron/services/mobile-preview-packet-capture-service.ts`
- Create: `electron/services/mobile-preview-packet-capture-service.test.ts`
- Modify: `shared/mobile-simulator-types.ts`

**Step 1: Define session types**

Add:

```ts
export type MobilePreviewPacketCaptureStatus =
  | 'running'
  | 'stopped'
  | 'errored';

export type MobilePreviewPacketCaptureSession = {
  id: string;
  platform: MobilePlatform;
  deviceId: string;
  status: MobilePreviewPacketCaptureStatus;
  command: string;
  error: string | null;
  updatedAt: string;
};
```

**Step 2: Write failing service tests**

Test:
- starts process with chosen command
- emits packet-only request metadata from parser input
- stop kills process and marks stopped

**Step 3: Implement shell**

Create service with:
- `start(params)`
- `stop(sessionId)`
- `onSession(listener)`
- `onRequest(listener)`

Keep parser simple for first pass: parse tcpdump-like lines into host/port/protocol/byte metadata when available.

**Step 4: Run**

```bash
pnpm test electron/services/mobile-preview-packet-capture-service.test.ts
pnpm ts-check
```

Expected: pass.

**Step 5: Commit**

```bash
git add shared/mobile-simulator-types.ts electron/services/mobile-preview-packet-capture-service.ts electron/services/mobile-preview-packet-capture-service.test.ts
git commit -m "feat(mobile-preview): add packet capture service"
```

---

### Task 4: Platform Capture Commands

**Files:**
- Modify: `electron/services/mobile-preview-packet-capture-service.ts`
- Test: `electron/services/mobile-preview-packet-capture-service.test.ts`

**Step 1: Write failing command-selection tests**

Expected initial commands:

```ts
// Android emulator/device, best effort
adb -s <deviceId> shell tcpdump -l -n

// iOS simulator, host-side best effort
sudo tcpdump -l -n -i any
```

If `sudo tcpdump` is too invasive, service should return clear unsupported error instead of prompting invisibly.

**Step 2: Implement conservative command selection**

Rules:
- Android: try `adb shell which tcpdump`; if missing, return unsupported error
- iOS simulator: do not auto-run sudo; return setup-needed state with suggested command
- Never start privileged command silently

**Step 3: Run**

```bash
pnpm test electron/services/mobile-preview-packet-capture-service.test.ts
pnpm ts-check
```

Expected: pass.

**Step 4: Commit**

```bash
git add electron/services/mobile-preview-packet-capture-service.ts electron/services/mobile-preview-packet-capture-service.test.ts
git commit -m "feat(mobile-preview): choose packet capture commands"
```

---

### Task 5: IPC Bridge

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-mobile-preview.ts`

**Step 1: Add API shape**

Add:

```ts
startPacketCapture(params)
stopPacketCapture(sessionId)
onPacketCaptureSession(callback)
onPacketCaptureRequest(callback)
```

**Step 2: Wire main service**

In `electron/ipc/handlers.ts`, route IPC to `mobilePreviewPacketCaptureService`.

**Step 3: Add hook**

Create `useMobilePreviewPacketCapture(params)` matching network proxy hook style.

**Step 4: Run**

```bash
pnpm ts-check
```

Expected: pass.

**Step 5: Commit**

```bash
git add electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts src/hooks/use-mobile-preview.ts
git commit -m "feat(mobile-preview): expose packet capture ipc"
```

---

### Task 6: UI Merge And Labels

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`

**Step 1: Add packet capture controls**

In Network tab:
- `Start proxy`
- `Start packet capture`
- status text for both
- warning text for packet-only limitations

**Step 2: Merge lists**

Combine proxy requests and packet-only requests by timestamp.

Show source chip:
- `MITM`
- `Proxy`
- `Tunnel`
- `Packet`

**Step 3: Run**

```bash
pnpm ts-check
pnpm lint
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/features/task/ui-task-panel/mobile-preview-pane/index.tsx
git commit -m "feat(mobile-preview): show packet capture network events"
```

---

### Task 7: Diagnostics And Empty-State Guidance

**Files:**
- Modify: `src/features/task/ui-task-panel/mobile-preview-pane/index.tsx`
- Modify: `electron/services/mobile-preview-packet-capture-service.ts`

**Step 1: Add diagnostics**

Show:
- proxy URL
- packet command/setup needed
- last event time
- “No traffic yet” reasons

**Step 2: Add no-traffic hints**

Hints:
- app may bypass proxy
- HTTPS body needs trusted CA
- cert pinning blocks decrypt
- packet capture only gives metadata

**Step 3: Run**

```bash
pnpm ts-check
pnpm lint
```

Expected: pass.

**Step 4: Commit**

```bash
git add src/features/task/ui-task-panel/mobile-preview-pane/index.tsx electron/services/mobile-preview-packet-capture-service.ts
git commit -m "improvement(mobile-preview): explain network capture state"
```

---

### Task 8: Full Verification

**Files:**
- No code changes unless failures require fixes.

**Step 1: Install**

```bash
pnpm install
```

Expected: pass, Node engine warning acceptable in current environment.

**Step 2: Test**

```bash
pnpm test
```

Expected: all tests pass.

**Step 3: Lint fix**

```bash
pnpm lint --fix
```

Expected: exit 0.

**Step 4: Type check**

```bash
pnpm ts-check
```

Expected: exit 0.

**Step 5: Final lint**

```bash
pnpm lint
```

Expected: exit 0.

**Step 6: Commit fixes**

```bash
git add .
git commit -m "test(mobile-preview): verify vpn-like network capture"
```

