import { access, cp, mkdir, rm } from "node:fs/promises";
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
    recursive: true,
  });
}

async function main() {
  const publicDir = path.join(appRoot, "public");
  const staticDir = path.join(nextDir, "static");
  const standaloneAppDir = path.join(desktopStandaloneDir, "apps", "next");

  await replaceDir(standaloneDir, desktopStandaloneDir);
  if (await pathExists(publicDir)) {
    await replaceDir(publicDir, path.join(standaloneAppDir, "public"));
  }

  if (await pathExists(staticDir)) {
    await replaceDir(staticDir, path.join(standaloneAppDir, ".next", "static"));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
