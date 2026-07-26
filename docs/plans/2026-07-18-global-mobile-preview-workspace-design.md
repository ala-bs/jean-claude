# Global Mobile Preview Workspace Design

## Goal

Move mobile preview from task-local content into a global workspace. Users can keep multiple task-owned Metro servers and preview streams running, then switch selected app/device to another Metro without navigating to its task.

## User Flow

```text
Header [Mobile · 3]
        |
        v
Global mobile workspace
├─ Task A · apps/mobile · 8081
├─ Task B · . · 8082
└─ Existing mobile preview workspace
```

1. Header phone button opens mobile workspace below global header.
2. Runtime rail lists running mobile dev servers plus current task when its project has mobile preview enabled.
3. Selecting a running Expo runtime restores task/app platform and device selection.
4. Jean-Claude asks running Expo server for its launch URL and opens that URL on exact selected device.
5. Preview stream starts or reattaches without stopping other runtime streams.
6. Header button or Escape closes workspace without stopping Metro or preview streams.

## Decisions

| Concern | Decision | Reason |
| --- | --- | --- |
| Surface | Full workspace below header | Existing three-column preview needs width; header stays globally accessible. |
| Entry | Header phone button | Always reachable; badge can expose running Metro count. |
| Task entry | Open global workspace preselected to task | One preview model with contextual fast path. |
| Runtime list | Running Metro servers plus current eligible task | Focused switcher that can still start current task's server. |
| Runtime identity | Task ID plus app path | Worktree remains process owner; multi-app tasks remain distinct. |
| Row hierarchy | Task, app, actual port; project/branch secondary | Optimized for parallel task work. |
| Device state | Persist per task and app | Parallel worktrees can use different platforms/devices. |
| App override | Runtime app path does not mutate project config | Switching existing server cannot alter project preference. |
| Port conflicts | Pick next available port | Enables parallel Metro servers from same project config. |
| Stopped current task | Open setup; do not auto-start Metro | Avoid surprising process creation. |
| Switch action | Launch app and start/attach stream | One-click visible switch. |
| Exact launch | Expo server URL plus selected-device native adapter | Server owns correct host, port, runtime, and deep-link scheme. |
| Vanilla RN | No automatic Metro switch in v1 | No standard runtime URL or arbitrary-port switch API exists. |
| Failure | Keep selected runtime and show Retry | Preserves diagnostics; never restarts Metro. |
| Stream lifecycle | Retain all started streams across close/switch | Matches current multi-device behavior and makes return instant. |
| Workspace reopen | Restore last valid runtime | Stable across task navigation. |
| Disabled project | Keep running Metro visible until stopped | Prevent hidden background processes. |

## Architecture

### Renderer

- Add persistent global mobile workspace store with visibility and selected runtime key.
- Host workspace from root layout, replacing sidebar and route content while open.
- Keep underlying route unchanged so closing restores prior context.
- Derive runtime index from global run-command status, tasks, projects, and current route.
- Move task phone action to global workspace store and remove task-local mobile view rendering.
- Extend mobile preview pane with runtime app-path and actual-port overrides.
- Persist platform/device selection under task ID plus app path.
- Keep launch state and retry feedback in selected preview context.

### Run Commands

- Mark mobile dev server status with actual assigned port.
- Extend ad-hoc command startup with available-port strategy.
- Prefer configured port; select next free port atomically when occupied.
- Append configured port override arguments to launched Metro command.
- Return effective command and port through normal status events.

### Expo Launch

```text
GET http://127.0.0.1:<actual-port>/_expo/open
  ?platform=ios|android
  &runtime=default
```

- Use returned URL verbatim.
- Fall back to legacy `/_expo/link` redirect metadata for older Expo CLI versions.
- Validate protocol and loopback request target.
- Open URL through existing iOS `simctl` or Android `adb -s` adapter, which targets exact selected device.
- Keep context and expose retry when discovery or device open fails.

### Preview Sessions

- Main process remains owner of capture sessions.
- Add session listing/reattachment API.
- Retain sessions when preview UI unmounts or changes task.
- Cache bounded decoder bootstrap data needed to resume H264/raw stream rendering.
- Explicit Stop, task completion/deletion, or app shutdown ends owned sessions.

## Edge Cases

- No saved booted device: show device selection; continue pending launch after selection.
- Metro exits during switch: keep context, show stopped state, disable launch retry until restarted.
- Project integration disabled after Metro starts: retain row until process exits.
- Running app differs from project-selected app: use runtime app override only.
- Multiple Metro servers use same configured port: each receives separate actual port.
- Expo endpoint returns ambiguous runtime page: open returned URL rather than guessing runtime.
- Vanilla React Native: preview capture remains available, but automatic Metro reassignment explains unsupported state.
- Task completion/deletion: stop Metro and retained streams to avoid orphaned resources.

## Verification

- Unit tests for global workspace store and runtime indexing.
- Run-command tests for available-port assignment and effective status metadata.
- Expo launch tests for current endpoint, legacy redirect fallback, URL validation, and exact device dispatch.
- Mobile preview service/hook tests for retained sessions and reattachment bootstrap.
- Integration tests for header entry, task preselection, runtime switching, close/reopen, and error retry.
- Run repository install, test, lint-fix, TypeScript, and final lint commands.
