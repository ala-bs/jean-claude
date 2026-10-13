# Mobile Build Store — Design
Date: 2026-09-28

## Problem

The Mobile Dev pane can build a native Android or iOS simulator app, but every reinstall currently rebuilds from scratch. Native builds are slow and the produced artifact is not retained as a reusable install target.

The Build Store will retain successful Android APKs and iOS Simulator `.app` bundles, associate them with a source/configuration fingerprint, and let users install a selected artifact onto the currently selected device without rebuilding.

## Users & success criteria

The primary user is a developer iterating in the Right Pane - Mobile Dev.

Success means:

- A successful Android or iOS simulator build appears in a Build Store for the detected package/bundle ID.
- A matching build can be installed on another compatible emulator/simulator without invoking the native build command.
- The user can inspect artifact platform, age, fingerprint status, size, and source metadata.
- The user can manually delete any stored artifact.
- Failed builds, ambiguous artifact discovery, interrupted copies, and failed installs never appear as successful cache entries.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| The Mobile Dev pane already resolves platform/device-specific native build commands. | `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-command.ts` |
| Builds currently run as ad-hoc commands through the shared command runner and are keyed by task/device. | `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx`, `electron/services/run-command-service.ts` |
| Android APK installation already exists and validates `adb install` output. | `electron/services/mobile-preview-android-adapter.ts` |
| iOS app installation already exists through `devicectl`. | `electron/services/mobile-preview-ios-devicectl.ts` |
| The application already uses SQLite/Kysely and Electron `userData` for durable local state. | `electron/database/`, `electron/database/index.ts` |
| There is no existing persistent native build artifact store. | Repository scan, 2026-09-28 |

## Decisions

- V1 supports Android APKs and iOS Simulator `.app` bundles. Signed iOS device IPAs are out of scope.
- Artifacts are reusable only when their source/configuration fingerprint matches the current project inputs.
- The store is exposed as a separate Build Store panel in the Mobile Dev pane.
- Build creates or refreshes an artifact and then offers Install; it does not silently alter the selected device.
- Artifacts are grouped globally by detected package/bundle ID, as requested. The fingerprint remains mandatory, so a matching artifact from a different checkout is not automatically treated as current.
- Keep all successful artifacts until the user deletes them manually.
- Artifact bytes live under `app.getPath('userData')/mobile-build-store/`; metadata lives in SQLite.
- V1 discovers standard Expo/React Native outputs. If discovery finds zero or multiple candidates, the build fails with an actionable message rather than guessing.
- An optional explicit artifact output configuration can be added later for custom build scripts; it is not required for V1.
- Artifacts are stored as flat entries in the main Git checkout at `<main-repo>/.jean-claude/build-artifacts/`. The service resolves the repository root from Git's shared `--git-common-dir`, so task worktrees share one store. Each metadata row records `repositoryPath`, and list queries filter on it to isolate repositories. Existing global user-data artifacts remain untouched as legacy data and are not mixed into repository-local lists.
- The Build Store list is intentionally lightweight: it reads the repository-local `build-artifacts` directory, filters only `.apk` or `.app` entries, and does not calculate fingerprints or require a bundle/package ID. Artifacts are stored as flat files/directories directly under that folder, with a timestamp/UUID filename to avoid collisions.

## Architecture

```text
Mobile Dev pane
   │  list / build / install / delete
   ▼
Preload bridge + typed renderer API
   ▼
IPC handlers
   ▼
Mobile build store service
   ├─ fingerprint project inputs
   ├─ run native build command
   ├─ discover standard APK/.app output
   ├─ atomically copy artifact into userData
   ├─ persist metadata in SQLite
   └─ install through existing platform adapters
          ├─ adb install -r
          └─ devicectl device install app
```

Responsibilities:

- `src/features/task/ui-task-panel/mobile-dev-pane/`: Build Store panel, artifact list, freshness state, install/delete actions, and build/install progress.
- `src/lib/api.ts` and `electron/preload.ts`: typed IPC surface only; no filesystem or child-process access in the renderer.
- `electron/ipc/handlers.ts`: validates request shape and delegates to the service.
- `electron/services/mobile-build-store-service.ts`: owns fingerprinting, build orchestration, discovery, atomic storage, metadata, and install dispatch.
- `electron/database/migrations/`: stores artifact metadata and indexes.
- Existing Android/iOS adapter modules: remain the only platform-specific install implementations.

## Data flow

### Build

1. The pane resolves the selected platform, package/bundle ID, app path, and native build command.
2. The renderer requests `mobileBuildStore.build`.
3. The main process computes a deterministic fingerprint from the app source, native configuration, lockfile, detected package identity, platform, and exact build command. Dependency/build output directories are excluded.
4. The service runs the existing command with the same working directory and log stream conventions as the current Build button.
5. On successful exit, the service searches the platform's standard output locations for a candidate artifact.
6. The service rejects zero candidates or ambiguous candidates and logs the search roots/candidates.
7. The artifact is copied to a temporary sibling path, validated by platform/extension, then atomically renamed to its final store path.
8. Metadata is inserted only after the copy succeeds.
9. The renderer receives the artifact record and offers Install.

### Install

1. The user selects a stored artifact and a compatible current device.
2. The main process verifies the metadata record and artifact path are inside the Build Store root and that the file still exists.
3. Android uses the existing APK adapter; iOS Simulator uses the existing simulator installation path.
4. `lastUsedAt` is updated only after the adapter reports success.
5. A missing/corrupt artifact is removed from the visible list after the failure is surfaced, with a diagnostic log entry.

### Delete

1. The user confirms deletion from the Build Store row.
2. The service deletes the artifact directory and metadata in a transaction-like sequence.
3. Partial deletion is surfaced and logged; no unrelated artifact path is touched.

## Data model

Migration: `NNN_mobile_build_store.ts`.

```text
mobile_build_artifacts
  id                text primary key
  platform          text not null              -- 'android' | 'ios'
  package_id        text not null              -- Android package or iOS bundle ID
  app_path          text not null              -- project-relative app path
  fingerprint       text not null
  build_command     text not null
  artifact_kind     text not null              -- 'apk' | 'ios-simulator-app'
  artifact_path     text not null              -- absolute path under userData store
  size_bytes        integer not null
  created_at        text not null
  last_used_at      text null

  index (package_id, platform, created_at)
  index (package_id, platform, fingerprint)
```

The database stores metadata only; it does not store artifact bytes. The service rejects paths outside the canonical Build Store root, including symlink escapes.

## Interfaces

Shared types:

```ts
type MobileBuildArtifactKind = 'apk' | 'ios-simulator-app';

type MobileBuildArtifact = {
  id: string;
  platform: 'android' | 'ios';
  packageId: string;
  appPath: string;
  fingerprint: string;
  buildCommand: string;
  artifactKind: MobileBuildArtifactKind;
  sizeBytes: number;
  createdAt: string;
  lastUsedAt: string | null;
  isCurrent: boolean;
};
```

IPC methods:

```ts
mobileBuildStore.list(params: {
  packageId: string;
  platform: 'android' | 'ios';
  projectPath: string;
  appPath: string;
  command: string;
}): Promise<MobileBuildArtifact[]>;

mobileBuildStore.build(params: {
  taskId: string;
  projectId: string;
  projectPath: string;
  appPath: string;
  platform: 'android' | 'ios';
  packageId: string;
  command: string;
}): Promise<MobileBuildArtifact>;

mobileBuildStore.install(params: {
  artifactId: string;
  device: MobilePreviewDevice;
}): Promise<void>;

mobileBuildStore.delete(params: {
  artifactId: string;
}): Promise<void>;
```

The build operation must retain the existing command log stream or return a command ID so the Build Store panel can show native build output. It must not create a second, renderer-only process runner.

## Fingerprinting

The fingerprint is a SHA-256 digest of sorted relative paths and file contents for relevant source/configuration files, plus canonical JSON for platform, app path, package ID, and exact build command.

Excluded directories include `node_modules`, common build output directories, caches, `.git`, and the Build Store itself. Included files include source files, native `android/` or `ios/` inputs, package manifests/lockfiles, Expo/native configuration, and project-level build configuration. The implementation should use an explicit exclusion list and log the input summary, not every file path, to keep logs useful.

## Artifact discovery

- Android: inspect standard Gradle output roots under the app path, prefer newly modified `.apk` files, and reject ambiguous candidates at the same confidence level.
- iOS Simulator: inspect Xcode build product roots for `*-iphonesimulator/*.app`, prefer the application bundle rather than extensions, and reject ambiguity.
- Candidate validation checks extension, regular-file/directory shape, modification time after build start, and canonical path containment within the project/app path.
- Discovery diagnostics include build start/end times, roots searched, candidate paths, and rejection reasons.

## Error handling and observability

| Failure | Behavior |
| --- | --- |
| Build command exits non-zero | Do not create metadata; preserve normal command logs and report build failure. |
| No artifact found | Report the searched roots and suggest configuring an output path in a future version. |
| Multiple artifacts found | Report candidates and require an explicit output path/configuration. |
| Copy interrupted | Delete only the temporary copy; no metadata is inserted. |
| Artifact missing later | Mark the row unavailable, log the path, and offer removal. |
| Incompatible platform/device | Reject before adapter invocation with a user-facing explanation. |
| Install adapter fails | Preserve the artifact, surface the adapter's error, and do not update `lastUsedAt`. |
| Concurrent build/store mutation | Serialize operations per package ID and use unique temporary paths. |

The service should log structured events for `fingerprint-start`, `build-start`, `build-exit`, `discovery-result`, `artifact-copy`, `install-start`, `install-result`, and `delete-result`, including platform/package ID/artifact ID and safe paths. This is especially important because artifact discovery is the part most likely to fail with custom Expo/RN setups.

## Security and safety

- All renderer inputs are validated in IPC handlers and again at the service boundary.
- Artifact paths are canonicalized and must remain beneath the app's Build Store root.
- Project paths must be trusted existing directories; shell command execution follows the existing command-runner permission model.
- Package/bundle IDs are validated using the existing platform rules where available.
- Deletion accepts only a database artifact ID, never an arbitrary filesystem path.

## Test strategy

- Unit tests for fingerprint stability, excluded/generated files, platform differences, and command changes.
- Unit tests for Android/iOS artifact discovery: one candidate, no candidate, ambiguous candidates, stale candidates, and invalid paths.
- Service tests for atomic copy, metadata insertion ordering, missing artifact cleanup, delete isolation, and concurrent package-scoped operations.
- IPC tests for request validation and adapter dispatch.
- Renderer tests for current/stale artifact labels, build-then-offer-install behavior, install/delete actions, loading states, and errors.
- Existing Android/iOS adapter tests remain the install correctness tests; add only the Build Store integration seams needed to prove dispatch.
- Manual verification on one Expo Android project and one Expo iOS simulator project: build, close/reopen app, select another compatible device, install from store, delete, and retry after an intentionally ambiguous output.

## Rollout and rollback

No feature flag is required because the panel can be additive and the current Build action remains available. The migration is additive. Rollback removes the UI and IPC usage but leaves stored artifacts and metadata harmlessly orphaned; a follow-up cleanup migration or store cleanup command can remove them.

## Guideline candidates

- **diagnostics** — Artifact discovery failures should report the searched locations and rejected candidates. Generalises to any automation that infers outputs from user-configurable commands.

## Open follow-up

Custom build scripts may not emit artifacts into standard Expo/React Native locations. A future settings field should allow an explicit per-platform artifact output template, e.g. `${project}/android/app/build/outputs/apk/release/app-release.apk`, without weakening path validation.

## UI refinement — compact build controls

The Mobile Dev pane keeps the primary build action visible and moves stored-build actions into an adjacent chevron menu:

```text
Metro ...                 [ Build ][⌄] [ Start ]
                                      │
                                      ├─ Current source · 204 MB  Install
                                      ├─ Older source · 198 MB   Install
                                      └─ Manage Build Store
```

Every successful normal Mobile Dev build automatically calls the store persistence seam with the original build start time. This preserves the existing command log/status flow while making every successful build reusable. The standalone Build & store action is removed.

The chevron menu is compact and refreshes its list when opened. Manage Build Store opens the existing modal system and provides the complete artifact list with per-artifact deletion. Build artifacts remain manually retained; no automatic eviction is added.

Each artifact also has an optional persisted display name. Manage Build Store provides rename and delete actions; unnamed legacy artifacts keep the generated Current source / Older source label. Both the menu and modal show a loading state while querying artifacts.
