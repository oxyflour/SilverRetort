import { ComponentType } from "react";
import { Artifact } from "silverretort-protocol";

export interface ArtifactRendererProps {
  artifact: Artifact;
}

export type ArtifactRenderer = ComponentType<ArtifactRendererProps>;

export interface ArtifactRendererDefinition {
  type: string;
  renderer: ArtifactRenderer;
  description?: string;
  payloadSchema?: unknown;
  examples?: unknown[];
}

export type ArtifactRendererReport = Omit<ArtifactRendererDefinition, "renderer">;

const renderers = new Map<string, ArtifactRendererDefinition>();

export function registerArtifactRenderer(
  typeOrDefinition: string | ArtifactRendererDefinition,
  renderer?: ArtifactRenderer,
) {
  const definition =
    typeof typeOrDefinition === "string"
      ? { type: typeOrDefinition, renderer }
      : typeOrDefinition;
  if (!definition.renderer) {
    throw new Error(`Artifact renderer is required for ${definition.type}`);
  }
  renderers.set(definition.type, definition as ArtifactRendererDefinition);
}

export function getArtifactRenderer(type: string): ArtifactRenderer | undefined {
  return renderers.get(type)?.renderer;
}

export function listRenderTypes(): string[] {
  return listRenderDefinitions().map((definition) => definition.type);
}

export function listRenderDefinitions(): ArtifactRendererReport[] {
  return [...renderers.values()].map(
    ({ type, description, payloadSchema, examples }) => ({
      type,
      description,
      payloadSchema,
      examples,
    }),
  );
}
