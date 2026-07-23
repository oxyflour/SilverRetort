import { createElement } from "react";
import { createRoot } from "react-dom/client";
import Circuit from "./circuit";
import type { CircuitData } from "./types";

export function mount(
  element: Element,
  data: CircuitData,
  onChange?: (data: CircuitData) => void,
) {
  const root = createRoot(element);
  root.render(createElement(Circuit, { data, onChange }));
  return () => root.unmount();
}

export { Circuit };
export { DEFAULT_CIRCUIT, normalizeCircuitData } from "./defaults";
