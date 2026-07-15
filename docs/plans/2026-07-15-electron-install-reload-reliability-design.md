# Electron Install and Reload Reliability Design

## Problem

An Electron dependency can exist in `node_modules` without its downloaded runtime (`dist/` and `path.txt`). `electron-vite` reads `path.txt` directly and fails with `Electron uninstall` instead of triggering Electron's package-level self-repair. This can leave a fresh checkout unusable even after `pnpm install` reports success.

Preview reload has a second reliability gap. It pulls, installs, builds, launches a detached replacement, waits 500 ms, and exits the working app without confirming that the replacement completed startup.

## Goals

- Make a successful root `pnpm install` guarantee a usable Electron runtime.
- Keep the current preview alive until its replacement proves it is ready.
- Keep the current preview running and report an actionable error when replacement startup fails.
- Preserve the existing pull, install, build, and preview-only behavior.

## Install Architecture

Add a project-owned Electron installation guard under `scripts/`. Root `postinstall` runs the guard before `electron-rebuild`.

The guard:

1. Resolves the installed Electron package.
2. Runs Electron's `install.js`, which is idempotent when the correct runtime already exists.
3. Reads `path.txt` and resolves the referenced executable.
4. Fails `pnpm install` with an actionable error when the executable is still unavailable.

This avoids relying on pnpm dependency lifecycle execution or side-effects cache correctness. Native modules are rebuilt only after the Electron runtime is verified.

## Reload Architecture

The current app first stops active agents with shutdown semantics and stops running project commands so the replacement cannot treat still-owned sessions as stale. It then keeps the existing pull, install, and build sequence, creates unique readiness, acknowledgment, and log paths in the OS temporary directory, releases the single-instance lock, and launches `pnpm preview:skip-build` with those paths in internal environment variables.

The replacement writes readiness only after database migrations, service initialization, IPC registration, main-window creation, and renderer loading complete. It writes a temporary marker and atomically renames it to the ready path. The current app polls for that marker while also monitoring early process exit and a 30-second timeout, then atomically renames the ready marker to the acknowledgment path.

- On success, the current app exits after acknowledgment. The replacement owns acknowledgment and startup-log cleanup and removes both when it later exits.
- On failure before readiness, the replacement leaves its startup log available so the current app can capture diagnostics before cleanup. The current app terminates the replacement process tree, cleans failed-attempt files, and retries single-instance lock recovery for about two seconds before reporting any recovery timeout or error alongside the primary startup failure.

Only replacement previews start a log limiter. Every five seconds it checks the inherited stdout file descriptor and truncates the shared startup log when it exceeds 1 MiB, avoiding reopen and locked-file behavior while bounding long-lived replacement output. Limiter failures are logged without failing startup, and its timer is cleared on process exit.

The existing `JC_` environment filtering prevents restart-only state from leaking into unrelated child processes.

## Failure Handling

- Electron download or verification failure makes `pnpm install` fail.
- Replacement early exit reports exit status and captured output.
- Replacement readiness timeout reports the timeout and captured output.
- Migration or renderer-load failure never writes readiness.
- Startup failures preserve the log until the current app has captured diagnostics.
- Acknowledged replacements own acknowledgment and log cleanup on exit.
- Single-instance lock recovery retries are bounded and preserve the primary startup error.
- Reload failure never calls `app.exit()`.

## Testing

- Unit-test Electron runtime verification with temporary package fixtures.
- Unit-test readiness signaling and polling with temporary files.
- Unit-test early exit, timeout, output capture, cleanup, and termination behavior with injected process boundaries.
- Unit-test active-agent and command shutdown, acknowledgment ownership, lock retries, and inherited-fd log limiting.
- Verify the focused suites, then run repository-required install, test, lint-fix, TypeScript, and final lint commands.

## Decisions

- Use an install guard plus readiness-file handshake.
- Treat renderer load as replacement readiness.
- Use a 30-second startup timeout.
- Keep update/git behavior unchanged.
- Do not introduce an external restart supervisor.
