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
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
      {...(payload.url ? { src: payload.url } : { srcDoc: payload.html ?? "" })}
    />
  );
}

/** image artifact payload：{ url } 或 { dataUri } */
function ImageRenderer({ artifact }: ArtifactRendererProps) {
  const payload = artifact.payload as { url?: string; dataUri?: string };
  const src = payload.url ?? payload.dataUri ?? "";
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
