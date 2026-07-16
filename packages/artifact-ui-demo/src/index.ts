import { registerArtifactRenderer } from "silverretort-chat-ui";
import { DemoStatArtifact } from "./DemoStatArtifact";
import demoStatPayloadSchema from "./generated/demo-stat.schema.json";

let registered = false;

export const DEMO_STAT_ARTIFACT_TYPE = "demo.stat";

export function registerDemoArtifactRenderers() {
  if (registered) return;
  registered = true;
  registerArtifactRenderer({
    type: DEMO_STAT_ARTIFACT_TYPE,
    renderer: DemoStatArtifact,
    description: "Compact statistic card with a primary value, optional trend badge, and secondary stats.",
    payloadSchema: demoStatPayloadSchema,
    examples: [
      {
        label: "Build health",
        value: 97,
        unit: "%",
        description: "A compact status card rendered by a React component from packages/artifact-ui-demo.",
        trend: { label: "+4% today", tone: "up" },
        items: [
          { label: "Passed checks", value: 31 },
          { label: "Warnings", value: 2 },
        ],
      },
    ],
  });
}

export { DemoStatArtifact };
export { demoStatPayloadSchema };
export type { DemoStatPayload } from "./payload";
export type { ArtifactRendererProps } from "silverretort-chat-ui";
