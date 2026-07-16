import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = path.join(rootDir, "src", "generated");

const generator = createGenerator({
  path: path.join(rootDir, "src", "types.ts"),
  tsconfig: path.join(rootDir, "tsconfig.json"),
  type: "CircuitData",
  expose: "export",
  jsDoc: "extended",
  topRef: false,
  additionalProperties: false,
});

const schema = generator.createSchema("CircuitData");

await mkdir(generatedDir, { recursive: true });
await writeFile(
  path.join(generatedDir, "circuit-data.schema.json"),
  `${JSON.stringify(schema, null, 2)}\n`,
  "utf8",
);
