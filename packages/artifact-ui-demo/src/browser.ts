import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DemoStat } from "./DemoStat";
import type { DemoStatPayload } from "./payload";

export function mount(element: Element, payload: DemoStatPayload) {
  const root = createRoot(element);
  root.render(createElement(DemoStat, { payload }));
  return () => root.unmount();
}
