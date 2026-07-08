# SilverRetort Desktop Packaging Design

## Context

SilverRetort currently has three independent app modules under `apps/`:

- `apps/desktop`: Electron shell
- `apps/next`: Node.js web service
- `apps/uvicorn`: Python backend

The current structure already matches the intended runtime split, but the build and packaging chain is incomplete:

- `apps/next` does not yet produce a standalone production bundle for Electron packaging.
- `apps/uvicorn` does not yet produce a self-contained distributable executable directory.
- `apps/desktop` still assumes development-style server startup in several places.
- The repository root is not yet configured as a formal `pnpm workspace`.

The reference implementation is `C:\Projects\GlassBeaker\apps`, where Electron packages a standalone Next.js bundle and a packaged Python runtime as extra resources, then starts those resources differently in development and packaged modes.

## Goals

- Produce one Electron installer or platform-default desktop artifact that contains both `apps/next` and `apps/uvicorn`.
- Keep development mode unchanged in principle:
  - `apps/desktop` starts `apps/next` and `apps/uvicorn`
  - `apps/uvicorn` still runs through `uv` during development
- Make release mode self-contained:
  - `apps/next` is packaged from a Next.js standalone build
  - `apps/uvicorn` is packaged as a `PyInstaller --onedir` application
- Promote the repository root to a formal `pnpm workspace`.
- Expose a single root command, `pnpm run build`, as the canonical desktop release build entrypoint.
- Ensure the build can succeed on each target platform when run on that platform locally.

## Non-Goals

- Cross-compiling Windows, macOS, and Linux artifacts from one host machine.
- Adding code-level feature changes to the web or Python applications.
- Introducing new automated tests in this change.
- Solving platform signing, notarization, or store submission workflows.
- Refactoring the three-app runtime split.

## Recommended Approach

Use the same high-level packaging model as GlassBeaker:

1. Build `apps/next` as a standalone Next.js server bundle.
2. Build `apps/uvicorn` as a self-contained `PyInstaller --onedir` runtime.
3. Package both outputs into `apps/desktop` with `electron-builder`.
4. Switch Electron startup behavior based on `app.isPackaged`.

This keeps the current app boundaries intact, matches the existing repo architecture, and minimizes changes to user-facing runtime behavior.

## Command Interface

The repository root becomes the public entrypoint for desktop work:

- `pnpm run dev`: runs the desktop app in development mode
- `pnpm run build`: builds the full desktop release artifact
- `pnpm run build:dir`: builds the unpacked Electron directory for local packaging verification

This requires a new `pnpm-workspace.yaml` with at least:

- `apps/*`
- `packages/*`

The root `package.json` should forward commands to `apps/desktop` through workspace filtering rather than hard-coded directory traversal.

## App-Level Build Responsibilities

### apps/next

`apps/next` remains the Node.js service used by the desktop shell.

Required changes:

- Enable `output: "standalone"` in `next.config.ts`.
- Set `outputFileTracingRoot` to the workspace root so Next includes the right monorepo dependency context.
- Keep the current health route so Electron can continue to block until the web service is ready.
- Extend the `build` script so it:
  - runs `next build`
  - copies `public/` into the standalone output
  - copies `.next/static/` into the standalone output

The expected packaged standalone layout is the monorepo-style Next output, with the runtime entry under:

- `apps/next/.next/standalone/apps/next/server.js`

This path should be treated as the canonical packaged Next entrypoint.

### apps/uvicorn

`apps/uvicorn` remains the Python service used by the desktop shell.

Required changes:

- Add a `package.json` for Node-driven command orchestration.
- Keep development behavior based on `uv`.
- Add a `build` script that runs `PyInstaller --onedir` through `uv`, so development does not gain a global `pyinstaller` requirement.
- Emit a stable output directory and executable name.

The packaged Python app should use a fixed name such as `silverretort-uvicorn`, producing:

- Windows: `dist/silverretort-uvicorn/silverretort-uvicorn.exe`
- macOS/Linux: `dist/silverretort-uvicorn/silverretort-uvicorn`

Electron startup logic should rely on this exact name rather than scanning the directory heuristically.

### apps/desktop

`apps/desktop` remains the only publishable desktop container.

Required changes:

- Rename packaging scripts to a uniform build vocabulary:
  - `build`: full installer or platform-default artifact
  - `build:dir`: unpacked Electron directory
- Make `build` and `build:dir` first invoke the `apps/next` and `apps/uvicorn` builds.
- Keep `electron-builder` as the packaging tool.
- Continue using `extraResources` to embed:
  - the Next standalone directory
  - the packaged Python runtime directory

The resulting desktop artifact is the only release artifact users need to install.

## Runtime Design

`apps/desktop/src/main.cjs` should remain the orchestrator for both backend services, but it must explicitly branch between development and packaged execution.

### Development Mode

When `app.isPackaged` is false:

- Python is started with `uv run uvicorn main:app --host 127.0.0.1 --port <port>` in `apps/uvicorn`.
- Next is started from the source app directory using the existing Node-based startup path.
- Health checks remain:
  - `http://127.0.0.1:<pythonPort>/health`
  - `http://127.0.0.1:<nextPort>/health`

This preserves current developer expectations and avoids coupling dev flow to packaged output structure.

### Packaged Mode

When `app.isPackaged` is true:

- Python is started from the packaged `PyInstaller --onedir` executable.
- Next is started by executing the packaged standalone `server.js`.
- Resource resolution is rooted at `process.resourcesPath`.

Expected packaged resource layout:

- Next: `<resources>/next/apps/next/server.js`
- Python executable:
  - Windows: `<resources>/uvicorn/silverretort-uvicorn/silverretort-uvicorn.exe`
  - macOS/Linux: `<resources>/uvicorn/silverretort-uvicorn/silverretort-uvicorn`

### Process Supervision

Process supervision remains simple and strict:

- Child process stdout and stderr are forwarded into Electron logs.
- If either child process exits unexpectedly, Electron quits.
- Electron only loads the main application URL after both health checks pass.

This is consistent with the current minimal-shell architecture and reduces undefined partially started states.

## Packaging Outputs

Platform output expectations are:

- Windows: `nsis`
- macOS: electron-builder default artifact for the local macOS host
- Linux: electron-builder default artifact for the local Linux host

The project does not promise cross-platform output from one machine. Instead, the promise is:

- Windows builds on Windows
- macOS builds on macOS
- Linux builds on Linux

## Verification Plan

No new automated tests are added in this task. Validation is build-oriented and manual.

Minimum acceptance checks:

1. `pnpm run build` works from the repository root.
2. `apps/next` produces a valid standalone build containing:
   - `.next/standalone/apps/next/server.js`
   - copied `public/`
   - copied `.next/static/`
3. `apps/uvicorn` produces a valid `PyInstaller --onedir` output with the fixed executable name.
4. `apps/desktop` produces:
   - an installer or default platform artifact for `build`
   - an unpacked Electron directory for `build:dir`
5. Running the unpacked desktop app starts both backend services and loads the main page successfully.
6. The packaged app can reach both `/health` endpoints before the BrowserWindow loads the application URL.

## Risks and Boundaries

- Next standalone output structure is sensitive to monorepo configuration, so `outputFileTracingRoot` must be set correctly.
- `PyInstaller` behavior may still vary slightly by platform, especially around bundled data files and hidden imports, but the current FastAPI app is small enough that the initial `onedir` setup should be straightforward.
- Signing and notarization are explicitly out of scope, so some produced artifacts may require local security exceptions depending on platform defaults.
- This design intentionally avoids adding a more complex service manager or retry system inside Electron.

## Implementation Summary

The implementation should:

1. convert the repo into a formal `pnpm workspace`
2. make `apps/next` emit a packageable standalone bundle
3. make `apps/uvicorn` emit a stable `PyInstaller --onedir` runtime
4. make `apps/desktop` build and package both outputs under one Electron artifact
5. preserve development mode while making packaged mode self-contained

That is the smallest coherent change set that satisfies the requested packaging behavior.
