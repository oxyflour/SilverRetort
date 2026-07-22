import { build } from "esbuild";

await build({
  entryPoints: ["assets/src/app.js"],
  bundle: true,
  minify: true,
  outfile: "assets/dist/app.js",
});
