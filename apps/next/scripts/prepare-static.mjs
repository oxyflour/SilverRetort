import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(configDir, "..");
const nextDir = path.join(appRoot, ".next");
const desktopStaticDir = path.join(nextDir, "desktop-static");

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(from, to) {
  if (!(await pathExists(from))) return;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true, dereference: true });
}

async function main() {
  await rm(desktopStaticDir, { recursive: true, force: true });
  await mkdir(desktopStaticDir, { recursive: true });

  await copyIfExists(path.join(nextDir, "server", "app", "index.html"), path.join(desktopStaticDir, "index.html"));
  await copyIfExists(path.join(nextDir, "server", "app", "_not-found.html"), path.join(desktopStaticDir, "404.html"));
  await copyIfExists(path.join(nextDir, "static"), path.join(desktopStaticDir, "_next", "static"));
  await copyIfExists(path.join(appRoot, "public"), desktopStaticDir);

  if (!(await pathExists(path.join(desktopStaticDir, "index.html")))) {
    throw new Error("missing prerendered Next index.html");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
