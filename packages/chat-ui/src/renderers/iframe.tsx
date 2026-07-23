import { useEffect, useMemo, useRef } from "react";
import {
  ApiClient,
  ArtifactContextMessageSchema,
  IframeArtifactPayloadSchema,
} from "silverretort-protocol";
import { ArtifactRendererProps } from "../registry";

type HostAck = {
  type: "silverretort.host.ack";
  version: 1;
  requestId: string;
  revision?: number;
  status: "saved" | "rejected";
  error?: string;
};

function rejectionMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Artifact context update failed.";
  }
  if (error.message.includes("HTTP 413")) {
    return "The artifact context is larger than 64 KiB.";
  }
  return error.message;
}

export function IframeRenderer({ artifact }: ArtifactRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const client = useMemo(() => new ApiClient(), []);
  const parsedPayload = useMemo(
    () => IframeArtifactPayloadSchema.safeParse(artifact.payload),
    [artifact.payload],
  );
  const payload = parsedPayload.success ? parsedPayload.data : null;
  const src =
    payload && "url" in payload
      ? payload.url
      : `/api/artifacts/${encodeURIComponent(artifact.id)}/content/`;
  const isExternal = Boolean(payload && "url" in payload);

  useEffect(() => {
    if (!payload || "url" in payload) {
      return;
    }
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    let activePort: MessagePort | null = null;
    const connect = () => {
      activePort?.close();
      const channel = new MessageChannel();
      activePort = channel.port1;

      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        let parsed: ReturnType<typeof ArtifactContextMessageSchema.safeParse>;
        try {
          parsed = ArtifactContextMessageSchema.safeParse(event.data);
        } catch {
          return;
        }
        if (!parsed.success) {
          return;
        }

        const message = parsed.data;
        const acknowledge = (ack: Omit<HostAck, "type" | "version" | "requestId">) => {
          channel.port1.postMessage({
            type: "silverretort.host.ack",
            version: 1,
            requestId: message.requestId,
            ...ack,
          } satisfies HostAck);
        };

        saveQueueRef.current = saveQueueRef.current.then(async () => {
          try {
            const context = await client.setArtifactContext(artifact.id, {
              action: message.action,
              data: message.data,
              displayText: message.displayText,
            });
            acknowledge({ status: "saved", revision: context.revision });
          } catch (error) {
            acknowledge({ status: "rejected", error: rejectionMessage(error) });
          }
        });
      };
      channel.port1.start();

      iframe.contentWindow?.postMessage(
        {
          type: "silverretort.artifact.init",
          version: 1,
          capabilities: ["submit"],
        },
        "*",
        [channel.port2],
      );
    };

    iframe.addEventListener("load", connect);
    connect();
    return () => {
      iframe.removeEventListener("load", connect);
      activePort?.close();
    };
  }, [artifact.id, client, payload]);

  if (!payload) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-red-500">
        Invalid iframe artifact payload
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={artifact.title}
      className="h-full w-full border-0 bg-white"
      sandbox={
        isExternal
          ? "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          : "allow-scripts allow-same-origin"
      }
      src={src}
    />
  );
}
