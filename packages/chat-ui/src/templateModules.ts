import algorithmResearchTemplate from "silverretort-template-algorithm-research";
import antennaDesignTemplate from "silverretort-template-antenna-design";
import industrialDesignTemplate from "silverretort-template-industrial-design";
import structuralDesignTemplate from "silverretort-template-structural-design";
import {
  WORKSPACE_TEMPLATE_API_VERSION,
  type WorkspaceTemplateModule,
} from "silverretort-template-sdk";

const builtinModules: WorkspaceTemplateModule[] = [
  structuralDesignTemplate,
  antennaDesignTemplate,
  industrialDesignTemplate,
  algorithmResearchTemplate,
];

const modules = new Map<string, WorkspaceTemplateModule>();
for (const templateModule of builtinModules) {
  if (templateModule.apiVersion !== WORKSPACE_TEMPLATE_API_VERSION) {
    console.warn(
      `Skipping workspace template module ${templateModule.id}: unsupported API version ${templateModule.apiVersion}`,
    );
    continue;
  }
  if (modules.has(templateModule.id)) {
    console.warn(`Skipping duplicate workspace template module ${templateModule.id}`);
    continue;
  }
  modules.set(templateModule.id, templateModule);
}

export function getWorkspaceTemplateModule(moduleId: string) {
  return modules.get(moduleId);
}
