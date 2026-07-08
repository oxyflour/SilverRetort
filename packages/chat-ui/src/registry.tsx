import { ComponentType } from "react";
import { Artifact } from "silverretort-protocol";

export interface ArtifactRendererProps {
  artifact: Artifact;
}

export type ArtifactRenderer = ComponentType<ArtifactRendererProps>;

const renderers = new Map<string, ArtifactRenderer>();

/** 注册 artifact 渲染器；apps 层用它接入图表/3D 等自定义组件 */
export function registerArtifactRenderer(type: string, renderer: ArtifactRenderer) {
  renderers.set(type, renderer);
}

export function getArtifactRenderer(type: string): ArtifactRenderer | undefined {
  return renderers.get(type);
}

/** 当前已注册的渲染器类型，经后端透出给 agent（ui_list_render_types） */
export function listRenderTypes(): string[] {
  return [...renderers.keys()];
}
