# Desktop Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one Electron desktop artifact that packages `apps/next` and `apps/uvicorn`, while keeping development mode on raw Next plus `uv`.

**Architecture:** Promote the repo to a real `pnpm workspace`, make `apps/next` emit a packageable standalone server bundle, make `apps/uvicorn` emit a fixed-name `PyInstaller --onedir` runtime, and teach `apps/desktop` to switch between development and packaged startup paths. Per repository instruction, no new automated tests are added in this task; verification is build- and runtime-based.

**Tech Stack:** `pnpm workspace`, Next.js standalone output, Electron, `electron-builder`, Python `uv`, `PyInstaller`

---

## File Map

- Create: `C:\Projects\SilverRetort\pnpm-workspace.yaml`
- Create: `C:\Projects\SilverRetort\apps\uvicorn\package.json`
- Create: `C:\Projects\SilverRetort\apps\next\scripts\prepare-standalone.mjs`
- Create: `C:\Projects\SilverRetort\docs/superpowers/plans/2026-07-08-desktop-packaging.md`
- Modify: `C:\Projects\SilverRetort\package.json`
- Modify: `C:\Projects\SilverRetort\apps\next\package.json`
- Modify: `C:\Projects\SilverRetort\apps\next\next.config.ts`
- Modify: `C:\Projects\SilverRetort\apps\desktop\package.json`
- Modify: `C:\Projects\SilverRetort\apps\desktop\src\main.cjs`
- Verify: `C:\Projects\SilverRetort\apps\next\.next\standalone\apps\next\server.js`
- Verify: `C:\Projects\SilverRetort\apps\uvicorn\dist\silverretort-uvicorn\`
- Verify: `C:\Projects\SilverRetort\apps\desktop\release\`

### Task 1: Promote The Repo To A Workspace

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`

- [ ] **Step 1: Add a workspace manifest**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Replace root scripts with workspace-filtered entrypoints**

```json
{
  "scripts": {
    "dev": "pnpm --filter silverretort-desktop run dev",
    "build": "pnpm --filter silverretort-desktop run build",
    "build:dir": "pnpm --filter silverretort-desktop run build:dir"
  }
}
```

- [ ] **Step 3: Run workspace discovery**

Run: `pnpm -r list --depth -1`
Expected: the command exits `0` and includes `silverretort-desktop` plus `silverretort-next`

- [ ] **Step 4: Commit the workspace wiring**

```bash
git add pnpm-workspace.yaml package.json
git commit -m "build: add pnpm workspace entrypoints"
```

### Task 2: Make apps/next Emit A Packaged Standalone Bundle

**Files:**
- Create: `apps/next/scripts/prepare-standalone.mjs`
- Modify: `apps/next/package.json`
- Modify: `apps/next/next.config.ts`

- [ ] **Step 1: Configure Next for standalone packaging**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(configDir, "../../"),
};

export default nextConfig;
```

- [ ] **Step 2: Add a post-build script that copies static assets into the standalone output**

```js
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(configDir, "..");
const nextDir = path.join(appRoot, ".next");
const standaloneDir = path.join(nextDir, "standalone");

await rm(path.join(standaloneDir, "public"), { recursive: true, force: true });
await mkdir(path.join(standaloneDir, ".next"), { recursive: true });
await cp(path.join(appRoot, "public"), path.join(standaloneDir, "public"), { recursive: true });
await cp(path.join(nextDir, "static"), path.join(standaloneDir, ".next", "static"), { recursive: true });
```

- [ ] **Step 3: Wire the Next build script to emit the final standalone tree**

```json
{
  "scripts": {
    "build": "next build && node scripts/prepare-standalone.mjs"
  }
}
```

- [ ] **Step 4: Run the Next build**

Run: `pnpm --filter silverretort-next run build`
Expected: exit `0` and `apps/next/.next/standalone/apps/next/server.js` exists

- [ ] **Step 5: Commit the standalone build changes**

```bash
git add apps/next/package.json apps/next/next.config.ts apps/next/scripts/prepare-standalone.mjs
git commit -m "build: prepare next standalone output"
```

### Task 3: Make apps/uvicorn Emit A Fixed PyInstaller Runtime

**Files:**
- Create: `apps/uvicorn/package.json`

- [ ] **Step 1: Add Node-visible package scripts for development and release builds**

```json
{
  "name": "silverretort-uvicorn",
  "private": true,
  "scripts": {
    "dev": "uv run --project . uvicorn main:app --host 127.0.0.1 --port 23001",
    "build": "uv run --project . --with pyinstaller pyinstaller --noconfirm --clean --onedir --name silverretort-uvicorn --distpath dist --workpath build --specpath build main.py"
  }
}
```

- [ ] **Step 2: Build the packaged Python runtime**

Run: `pnpm --filter silverretort-uvicorn run build`
Expected: exit `0` and the executable exists at:
- Windows: `apps/uvicorn/dist/silverretort-uvicorn/silverretort-uvicorn.exe`
- macOS/Linux: `apps/uvicorn/dist/silverretort-uvicorn/silverretort-uvicorn`

- [ ] **Step 3: Commit the Python packaging command**

```bash
git add apps/uvicorn/package.json
git commit -m "build: package uvicorn backend with pyinstaller"
```

### Task 4: Teach Electron To Build And Launch The Packaged Services

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/main.cjs`

- [ ] **Step 1: Rename desktop packaging scripts and make them build dependencies first**

```json
{
  "scripts": {
    "dev": "electron .",
    "build:dir": "pnpm --filter silverretort-next run build && pnpm --filter silverretort-uvicorn run build && electron-builder --dir --publish never",
    "build": "pnpm --filter silverretort-next run build && pnpm --filter silverretort-uvicorn run build && electron-builder --publish never"
  }
}
```

- [ ] **Step 2: Keep `extraResources` aligned with the packaged app layout**

```json
{
  "build": {
    "extraResources": [
      {
        "from": "../next/.next/standalone",
        "to": "next",
        "filter": ["**/*"]
      },
      {
        "from": "../uvicorn/dist",
        "to": "uvicorn",
        "filter": ["**/*"]
      }
    ]
  }
}
```

- [ ] **Step 3: Split desktop runtime resolution between development and packaged mode**

```js
const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");

function resolveNextEntry() {
  return app.isPackaged
    ? path.join(root, "next", "apps", "next", "server.js")
    : path.join(root, "next", "node_modules", "next", "dist", "bin", "next");
}

function resolvePythonRuntime() {
  if (!app.isPackaged) {
    return {
      command: "uv",
      args: ["run", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "23001"],
      cwd: path.join(root, "uvicorn"),
    };
  }

  const exeName = process.platform === "win32"
    ? "silverretort-uvicorn.exe"
    : "silverretort-uvicorn";

  return {
    command: path.join(root, "uvicorn", "silverretort-uvicorn", exeName),
    args: [],
    cwd: path.join(root, "uvicorn", "silverretort-uvicorn"),
  };
}
```

- [ ] **Step 4: Start packaged Next by running the standalone server directly**

```js
const nextjs = utilityProcess.fork(resolveNextEntry(), [], {
  env: {
    ...process.env,
    PORT: `${nextJsPort}`,
    HOSTNAME: "127.0.0.1",
    API_REWRITE: `http://127.0.0.1:${pythonPort}/`,
  },
  cwd: app.isPackaged ? path.join(root, "next", "apps", "next") : path.join(root, "next"),
  stdio: "pipe",
});
```

- [ ] **Step 5: Build the unpacked desktop artifact**

Run: `pnpm run build:dir`
Expected: exit `0` and `apps/desktop/release/` contains the unpacked Electron app with embedded `next/` and `uvicorn/` resources

- [ ] **Step 6: Commit the desktop packaging logic**

```bash
git add apps/desktop/package.json apps/desktop/src/main.cjs
git commit -m "build: package next and uvicorn into desktop app"
```

### Task 5: Produce A Full Release Artifact And Verify Runtime

**Files:**
- Verify only

- [ ] **Step 1: Run the full repository build**

Run: `pnpm run build`
Expected: exit `0` and the platform-default release artifact is created under `apps/desktop/release/`

- [ ] **Step 2: Run the unpacked desktop app manually**

Run one of:
- Windows: start the unpacked `.exe`
- macOS: open the unpacked `.app`
- Linux: run the unpacked executable

Expected:
- the Electron window opens
- `/health` succeeds for both backend services before the app loads
- the main Next page renders

- [ ] **Step 3: Inspect the final repository state**

Run: `git status --short`
Expected: only intended packaging and build-script changes remain

