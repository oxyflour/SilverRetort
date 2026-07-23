import { DemoStatArtifact } from "../../artifact-ui-demo/src/DemoStatArtifact";
import demoStatPayloadSchema from "../../artifact-ui-demo/src/generated/demo-stat.schema.json";
import { createMount } from "./mount";

export const mount = createMount(
  "demo.stat",
  "Statistic",
  DemoStatArtifact,
  demoStatPayloadSchema,
);
