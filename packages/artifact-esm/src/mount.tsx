import Ajv, { type ErrorObject } from "ajv";
import { createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "./components.css";

type ArtifactComponent = ComponentType<{
  artifact: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    payload: unknown;
    createdAt: string;
  };
}>;

export interface MountOptions {
  setContext?: (
    action: string,
    data: unknown,
    options?: { displayText?: string },
  ) => Promise<unknown>;
}

function ensureStylesheet() {
  const id = "silverretort-artifact-components-v1";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  const stylesheetUrl = new URL(import.meta.url);
  stylesheetUrl.pathname = stylesheetUrl.pathname.replace(
    /(?:chunks\/[^/]+|[^/]+)$/,
    "components.css",
  );
  link.href = stylesheetUrl.href;
  document.head.append(link);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function createMount(
  componentId: string,
  title: string,
  Component: ArtifactComponent,
  propsSchema: object,
) {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(propsSchema);
  return (element: Element, props: unknown, _options?: MountOptions): (() => void) => {
    if (!validate(props)) {
      throw new TypeError(`Invalid props for ${componentId}: ${formatErrors(validate.errors)}`);
    }
    ensureStylesheet();
    const root = createRoot(element);
    root.render(createElement(Component, {
      artifact: {
        id: `esm:${componentId}`,
        sessionId: "iframe",
        type: componentId,
        title,
        payload: props,
        createdAt: new Date().toISOString(),
      },
    }));
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
    };
  };
}
