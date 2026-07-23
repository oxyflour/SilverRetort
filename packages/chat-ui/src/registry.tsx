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

export interface ArtifactModuleReport {
  id: string;
  importUrl: string;
  description?: string;
  exports: string[];
  payloadSchema?: unknown;
  usage?: string;
}

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

export function listRenderDefinitions(
  artifactModules: ArtifactModuleReport[] = [],
): ArtifactRendererReport[] {
  return [...renderers.values()].map(
    ({ type, description, payloadSchema, examples }) =>
      type === "iframe" && artifactModules.length > 0
        ? {
            type,
            description,
            payloadSchema,
            examples,
            modules: artifactModules,
          }
        : { type, description, payloadSchema, examples },
  );
}
