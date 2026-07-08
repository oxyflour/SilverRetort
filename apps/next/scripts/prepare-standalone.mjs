import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(configDir, "..");
const nextDir = path.join(appRoot, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const desktopStandaloneDir = path.join(nextDir, "desktop-standalone");

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function replaceDir(from, to) {
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    dereference: true,
    recursive: true,
  });
}

async function copyDirContents(from, to) {
  await mkdir(to, { recursive: true });

  for (const entry of await readdir(from)) {
    await cp(path.join(from, entry), path.join(to, entry), {
      dereference: true,
      force: true,
      recursive: true,
    });
  }
}

async function main() {
  const publicDir = path.join(appRoot, "public");
  const staticDir = path.join(nextDir, "static");
  const hoistedNodeModulesDir = path.join(standaloneDir, "node_modules", ".pnpm", "node_modules");

  await replaceDir(standaloneDir, desktopStandaloneDir);
  await copyDirContents(
    hoistedNodeModulesDir,
    path.join(desktopStandaloneDir, "apps", "next", "node_modules"),
  );

  if (await pathExists(publicDir)) {
    await replaceDir(publicDir, path.join(desktopStandaloneDir, "public"));
  }

  if (await pathExists(staticDir)) {
    await replaceDir(staticDir, path.join(desktopStandaloneDir, ".next", "static"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
