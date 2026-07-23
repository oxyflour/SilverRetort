import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IframeArtifactPayloadSchema } from "silverretort-protocol";
import { registerArtifactRenderer, ArtifactRendererProps } from "../registry";
import { IframeRenderer as InteractiveIframeRenderer } from "./iframe";

const iframePayloadSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri", pattern: "^https?://" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["workspacePort"],
      properties: {
        workspacePort: {
          type: "object",
          additionalProperties: false,
          required: ["port"],
          properties: {
            port: { type: "integer", minimum: 1, maximum: 65535 },
            path: {
              type: "string",
              description:
                "Optional URL route on the running HTTP server, not a workspace file path. Omit or use an empty string when the server serves its entry at /. Do not use values like site/index.html unless http://127.0.0.1:PORT/site/index.html really works. workspacePort is only a proxy; any POST API used by the page must be implemented by the server on this port and verified through the proxy.",
            },
          },
        },
      },
    },
  ],
};

const markdownPayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
};

function IframeRenderer({ artifact }: ArtifactRendererProps) {
  const parsed = IframeArtifactPayloadSchema.safeParse(artifact.payload);
  if (!parsed.success) {
    return <div className="flex h-full items-center justify-center p-4 text-sm text-red-500">Invalid iframe artifact payload</div>;
  }

  return (
    <InteractiveIframeRenderer artifact={artifact} />
  );
}

/** markdown artifact payload：{ text } */
function MarkdownArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as { text?: string };
  return (
    <div className="prose prose-sm dark:prose-invert h-full max-w-none overflow-auto p-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.text ?? ""}</ReactMarkdown>
    </div>
  );
}

let registered = false;

/** 注册内置渲染器（幂等）；apps 层入口调用一次 */
export function registerBuiltinRenderers() {
  if (registered) return;
  registered = true;
  registerArtifactRenderer({
    type: "iframe",
    renderer: IframeRenderer,
    description: "Iframe artifact served from a workspace-relative HTML entry file, an external http(s) URL, or a workspace loopback port preview.",
    payloadSchema: iframePayloadSchema,
  });
  registerArtifactRenderer({
    type: "markdown",
    renderer: MarkdownArtifactRenderer,
    description: "Markdown document artifact.",
    payloadSchema: markdownPayloadSchema,
  });
}
