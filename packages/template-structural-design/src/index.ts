import { DomainDesignToolbar } from "silverretort-template-domain-ui";
import {
  WORKSPACE_TEMPLATE_API_VERSION,
  type WorkspaceTemplateModule,
} from "silverretort-template-sdk";

const structuralDesignTemplate: WorkspaceTemplateModule = {
  apiVersion: WORKSPACE_TEMPLATE_API_VERSION,
  id: "structural-design",
  components: { chatPaneToolbar: DomainDesignToolbar },
};

export default structuralDesignTemplate;
