import { registerArtifactRenderer } from "silverretort-chat-ui";
import { CircuitArtifact } from "./CircuitArtifact";
import circuitDataSchema from "./generated/circuit-data.schema.json";

let registered = false;

export const CIRCUIT_ARTIFACT_TYPE = "circuit";

export function registerCircuitArtifactRenderers() {
  if (registered) return;
  registered = true;
  registerArtifactRenderer({
    type: CIRCUIT_ARTIFACT_TYPE,
    renderer: CircuitArtifact,
    description: "Interactive RF/electrical circuit editor. Payload is CircuitData with blocks and links.",
    payloadSchema: circuitDataSchema,
    examples: [
      {
        blocks: [
          { id: "TermG1", label: "TermG", position: { x: 120, y: 140 }, type: "port" },
          { id: "C1", position: { x: 300, y: 140 }, type: "capacitor" },
          { id: "L1", position: { x: 480, y: 120 }, type: "inductor" },
          { id: "TermG2", label: "TermG", position: { x: 680, y: 140 }, type: "port" },
        ],
        links: [
          { from: { node: "TermG1", pin: 0 }, to: { node: "C1", pin: 0 } },
          { from: { node: "C1", pin: 0 }, to: { node: "L1", pin: 0 } },
          { from: { node: "L1", pin: 1 }, to: { node: "TermG2", pin: 0 } },
        ],
      },
    ],
  });
}

export { default as Circuit } from "./circuit";
export { default } from "./circuit";
export { CircuitArtifact };
export { circuitDataSchema };
export {
  DEFAULT_CIRCUIT,
  PALETTE_ITEMS,
  BLOCK_META,
  createBlock,
  normalizeCircuitData,
  syncPositions,
} from "./defaults";
export type {
  Block,
  BlockPin,
  BlockLayout,
  CircuitBlockType,
  CircuitData,
  Link,
  LinkPin,
  PaletteItem,
  Point,
  Rect,
  RoutedLink,
} from "./types";
