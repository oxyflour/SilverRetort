import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import { defineConfig } from "vite";
import demoStatPayloadSchema from "../artifact-ui-demo/src/generated/demo-stat.schema.json";
import circuitDataSchema from "../circuit-ui/src/generated/circuit-data.schema.json";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [{
    name: "artifact-safe-circuit-worker",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "./use-routing-worker"
        && importer?.replaceAll("\\", "/").endsWith("/circuit-ui/src/circuit.tsx")
      ) {
        return path.resolve(packageRoot, "src/use-routing-worker.ts");
      }
    },
  }, {
    name: "artifact-module-catalog",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "catalog.json",
        source: `${JSON.stringify({
          version: 1,
          modules: [
            {
              id: "demo.stat",
              version: "1.0.0",
              description: "Compact statistic card with a primary value, trend badge, and secondary stats.",
              modulePath: "demo.stat.js",
              exportName: "mount",
              propsSchema: demoStatPayloadSchema,
              example: {
                label: "Build health",
                value: 97,
                unit: "%",
                trend: { label: "+4% today", tone: "up" },
              },
            },
            {
              id: "circuit",
              version: "1.0.0",
              description: "Interactive RF/electrical circuit editor.",
              modulePath: "circuit.js",
              exportName: "mount",
              propsSchema: circuitDataSchema,
              example: {
                blocks: [
                  { id: "P1", label: "Input", position: { x: 120, y: 140 }, type: "port" },
                  { id: "C1", position: { x: 320, y: 140 }, type: "capacitor" },
                ],
                links: [
                  { from: { node: "P1", pin: 0 }, to: { node: "C1", pin: 0 } },
                ],
              },
            },
          ],
        }, null, 2)}\n`,
      });
    },
  }],
  css: {
    postcss: { plugins: [tailwindcss()] },
  },
  build: {
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: path.resolve(packageRoot, "../../apps/next/public/artifact-components/v1"),
    lib: {
      entry: {
        "demo.stat": path.resolve(packageRoot, "src/demo-stat.tsx"),
        circuit: path.resolve(packageRoot, "src/circuit.tsx"),
      },
      formats: ["es"],
      cssFileName: "components",
    },
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
