import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGenerator } from "ts-json-schema-generator";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = path.join(rootDir, "src", "generated");

const generator = createGenerator({
  path: path.join(rootDir, "src", "payload.ts"),
  tsconfig: path.join(rootDir, "tsconfig.json"),
  type: "DemoStatPayload",
  expose: "export",
  jsDoc: "extended",
  topRef: false,
  additionalProperties: false,
});

const schema = generator.createSchema("DemoStatPayload");

await mkdir(generatedDir, { recursive: true });
await writeFile(
  path.join(generatedDir, "demo-stat.schema.json"),
  `${JSON.stringify(schema, null, 2)}\n`,
  "utf8",
);
