import { DomainDesignToolbar } from "silverretort-template-domain-ui";
import {
  WORKSPACE_TEMPLATE_API_VERSION,
  type WorkspaceTemplateModule,
} from "silverretort-template-sdk";

const algorithmResearchTemplate: WorkspaceTemplateModule = {
  apiVersion: WORKSPACE_TEMPLATE_API_VERSION,
  id: "algorithm-research",
  components: { chatPaneToolbar: DomainDesignToolbar },
};

export default algorithmResearchTemplate;
