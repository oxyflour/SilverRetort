# Artifact UI demo

This package shows the recommended pattern for custom React artifact renderers:

1. Put reusable UI in a `packages/*` workspace package.
2. Define the payload as a TypeScript interface in `src/payload.ts`.
3. Generate JSON Schema with `pnpm --filter silverretort-artifact-ui-demo run schema`.
4. Export a single `register*ArtifactRenderers()` function that registers the generated schema.
5. Call that function once from `apps/next/app/page.tsx`.
6. Tell the agent to use `ui_list_render_types` before calling `ui_show_artifact`.

Registered type:

```text
demo.stat
```

Example MCP call payload:

```json
{
  "session_id": "<current session id>",
  "type": "demo.stat",
  "title": "Build health",
  "payload": {
    "label": "Build health",
    "value": 97,
    "unit": "%",
    "description": "A compact status card rendered by a React component from packages/artifact-ui-demo.",
    "trend": {
      "label": "+4% today",
      "tone": "up"
    },
    "items": [
      {
        "label": "Passed checks",
        "value": 31
      },
      {
        "label": "Warnings",
        "value": 2
      }
    ]
  }
}
```

Use `ui_update_artifact(artifact_id, payload)` with the same payload shape to update the card.
