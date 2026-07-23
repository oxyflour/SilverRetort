# UI module demo

This package demonstrates a reusable UI module for `iframe` artifacts.

1. Define the module payload as a TypeScript interface in `src/payload.ts`.
2. Generate its JSON Schema with `pnpm --filter silverretort-artifact-ui-demo run schema`.
3. Export a browser `mount(element, payload)` entry point from `src/browser.ts`.
4. Add the module to the explicit whitelist in `scripts/build-artifact-modules.mjs`.

The workspace build publishes the module as browser ESM and generates the
server-owned metadata used by `ui_list_render_types`. The `iframe` renderer
definition includes the module import URL, exports, and payload schema without
waiting for a browser capability report. The agent can create an `iframe`
artifact whose page dynamically imports that URL and calls `mount`.

The module does not register or introduce a separate artifact type.
