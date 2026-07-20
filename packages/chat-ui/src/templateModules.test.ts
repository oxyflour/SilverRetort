import { describe, expect, it } from "vitest";
import { getWorkspaceTemplateModule } from "./templateModules";

describe("workspace template module registry", () => {
  it.each([
    "structural-design",
    "antenna-design",
    "industrial-design",
    "algorithm-research",
  ])("registers the built-in %s module", (moduleId) => {
    const templateModule = getWorkspaceTemplateModule(moduleId);

    expect(templateModule?.apiVersion).toBe(1);
    expect(templateModule?.id).toBe(moduleId);
    expect(templateModule?.components?.chatPaneToolbar).toBeTypeOf("function");
  });

  it("returns undefined for a module that was not bundled", () => {
    expect(getWorkspaceTemplateModule("missing-module")).toBeUndefined();
  });
});
