export { default as Circuit } from "./circuit";
export { default } from "./circuit";
export { default as circuitDataSchema } from "./generated/circuit-data.schema.json";
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
