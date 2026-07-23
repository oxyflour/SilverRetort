# UI module demo

This package demonstrates a reusable UI module for `iframe` artifacts.

1. Define the module payload as a TypeScript interface in `src/payload.ts`.
2. Generate its JSON Schema with `pnpm --filter silverretort-artifact-ui-demo run schema`.
3. Export a browser `mount(element, payload)` entry point from `src/browser.ts`.
4. Declare the entry point and schema in `silverretortArtifactModule` in `package.json`.

The workspace build publishes the module as browser ESM and includes its import
URL, exports, and payload schema in the `iframe` renderer definition returned by
`ui_list_render_types`. The agent can create an `iframe` artifact whose page
dynamically imports that URL and calls `mount`.

The module does not register or introduce a separate artifact type.
