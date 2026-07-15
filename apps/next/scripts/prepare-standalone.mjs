import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(configDir, "..");
const tracingRoot = path.resolve(appRoot, "../..");
const nextDir = path.join(appRoot, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const desktopStandaloneDir = path.join(nextDir, "desktop-standalone");
const standaloneAppDir = path.join(standaloneDir, "apps", "next");
const desktopAppDir = path.join(desktopStandaloneDir, "apps", "next");

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

// Next 16 emits absolute Windows junctions for pnpm dependencies. Redirect them
// into the already-pruned standalone tree instead of copying full workspace packages.
async function resolveTracedLink(sourcePath) {
  const target = await readlink(sourcePath);
  const resolvedTarget = path.resolve(path.dirname(sourcePath), target);

  if (isInside(standaloneDir, resolvedTarget) && await pathExists(resolvedTarget)) {
    return resolvedTarget;
  }

  const relativeTarget = path.relative(tracingRoot, resolvedTarget);
  if (!isInside(tracingRoot, resolvedTarget)) {
    throw new Error(`Standalone link escapes tracing root: ${sourcePath} -> ${target}`);
  }

  const tracedTarget = path.join(standaloneDir, relativeTarget);
  if (!await pathExists(tracedTarget)) {
    // The trace can retain a package-manager link while omitting its unused target.
    console.warn(`Skipping untraced standalone link: ${sourcePath} -> ${target}`);
    return null;
  }

  return tracedTarget;
}

async function copyTracedEntry(from, to, ancestors = new Set()) {
  const stats = await lstat(from);

  if (stats.isSymbolicLink()) {
    const tracedTarget = await resolveTracedLink(from);
    if (tracedTarget) {
      await copyTracedEntry(tracedTarget, to, ancestors);
    }
    return;
  }

  if (stats.isDirectory()) {
    const resolvedSource = path.resolve(from);
    const sourceKey = process.platform === "win32" ? resolvedSource.toLowerCase() : resolvedSource;
    if (ancestors.has(sourceKey)) {
      throw new Error(`Cyclic standalone dependency link at ${from}`);
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(sourceKey);
    await mkdir(to, { recursive: true });

    for (const entry of await readdir(from)) {
      await copyTracedEntry(path.join(from, entry), path.join(to, entry), nextAncestors);
    }
    return;
  }

  if (!stats.isFile()) {
    throw new Error(`Unsupported standalone entry: ${from}`);
  }

  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  await chmod(to, stats.mode);
}

async function copyDirContents(from, to, excludedNames = new Set()) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    if (!excludedNames.has(entry)) {
      await copyTracedEntry(path.join(from, entry), path.join(to, entry));
    }
  }
}

async function main() {
  const publicDir = path.join(appRoot, "public");
  const staticDir = path.join(nextDir, "static");
  const hoistedNodeModulesDir = path.join(standaloneDir, "node_modules", ".pnpm", "node_modules");

  await rm(desktopStandaloneDir, { recursive: true, force: true });
  await copyDirContents(standaloneAppDir, desktopAppDir, new Set(["node_modules"]));
  await copyDirContents(hoistedNodeModulesDir, path.join(desktopAppDir, "node_modules"));

  if (await pathExists(publicDir)) {
    await copyTracedEntry(publicDir, path.join(desktopAppDir, "public"));
  }

  if (await pathExists(staticDir)) {
    await copyTracedEntry(staticDir, path.join(desktopAppDir, ".next", "static"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
