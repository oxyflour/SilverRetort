import { DomainDesignToolbar } from "silverretort-template-domain-ui";
import {
  WORKSPACE_TEMPLATE_API_VERSION,
  type WorkspaceTemplateModule,
} from "silverretort-template-sdk";

const industrialDesignTemplate: WorkspaceTemplateModule = {
  apiVersion: WORKSPACE_TEMPLATE_API_VERSION,
  id: "industrial-design",
  components: { chatPaneToolbar: DomainDesignToolbar },
};

export default industrialDesignTemplate;
