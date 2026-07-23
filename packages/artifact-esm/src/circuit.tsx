import { CircuitArtifact } from "../../circuit-ui/src/CircuitArtifact";
import circuitDataSchema from "../../circuit-ui/src/generated/circuit-data.schema.json";
import { createMount } from "./mount";

export const mount = createMount(
  "circuit",
  "Circuit",
  CircuitArtifact,
  circuitDataSchema,
);
