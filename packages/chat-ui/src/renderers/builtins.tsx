import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { registerArtifactRenderer, ArtifactRendererProps } from "../registry";

/** iframe artifact payload：{ url } 或 { html } 二选一 */
function IframeRenderer({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as { url?: string; html?: string };
  return (
    <iframe
      title={artifact.title}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
      {...(payload.url ? { src: payload.url } : { srcDoc: payload.html ?? "" })}
    />
  );
}

type ImageArtifactPayload = {
  url?: string;
  dataUri?: string;
  path?: string;
  filePath?: string;
  localPath?: string;
  src?: string;
};

function isLocalImageUrl(value: string): boolean {
  return value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function toImageSrc(payload: ImageArtifactPayload): string {
  const localPath = payload.path ?? payload.filePath ?? payload.localPath;
  if (localPath) {
    return `/api/local-image?path=${encodeURIComponent(localPath)}`;
  }
  const url = payload.url ?? payload.src;
  if (url && isLocalImageUrl(url)) {
    return `/api/local-image?path=${encodeURIComponent(url)}`;
  }
  return url ?? payload.dataUri ?? "";
}

/** image artifact payload：{ url }、{ dataUri } 或 { path/filePath/localPath } */
function ImageRenderer({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as ImageArtifactPayload;
  const src = toImageSrc(payload);
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto p-4">
      <img src={src} alt={artifact.title} className="max-h-full max-w-full object-contain" />
    </div>
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
  registerArtifactRenderer("iframe", IframeRenderer);
  registerArtifactRenderer("image", ImageRenderer);
  registerArtifactRenderer("markdown", MarkdownArtifactRenderer);
}
