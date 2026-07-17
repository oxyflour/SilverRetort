"use client";

import { registerDemoArtifactRenderers } from "silverretort-artifact-ui-demo";
import { registerCircuitArtifactRenderers } from "silverretort-circuit-ui";

export function registerAppArtifactRenderers() {
  registerCircuitArtifactRenderers();
  registerDemoArtifactRenderers();
}
