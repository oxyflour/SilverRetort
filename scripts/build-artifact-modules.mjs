import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packagesDir = path.join(root, "packages");
const outputDir = path.join(root, "apps", "next", "public", "artifact-modules");

await mkdir(outputDir, { recursive: true });
const modules = [];

for (const directory of (await readdir(packagesDir, { withFileTypes: true }))) {
  if (!directory.isDirectory()) continue;
  const packageDir = path.join(packagesDir, directory.name);
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const definition = packageJson.silverretortArtifactModule;
  if (!definition) continue;

  const outputFile = path.join(outputDir, `${definition.id}.js`);
  await build({
    entryPoints: [path.join(packageDir, definition.entry)],
    outfile: outputFile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
  });

  if (definition.id === "circuit") {
    const source = await readFile(outputFile, "utf8");
    await writeFile(outputFile, source.replace("./routing.worker.ts", "./circuit-routing-worker.js"));
    await build({
      entryPoints: [path.join(packageDir, "src", "routing.worker.ts")],
      outfile: path.join(outputDir, "circuit-routing-worker.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
    });
  }

  modules.push({
    id: definition.id,
    importPath: `/artifact-modules/${definition.id}.js`,
    description: definition.description,
    exports: definition.exports,
    usage: "In iframe JavaScript, dynamically import importUrl, then call module.mount(element, payload). The returned function unmounts the module.",
    payloadSchema: JSON.parse(
      await readFile(path.join(packageDir, definition.payloadSchema), "utf8"),
    ),
  });
}

await writeFile(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify({ modules }, null, 2)}\n`,
);
