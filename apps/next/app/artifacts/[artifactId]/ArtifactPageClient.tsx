"use client";

import { ArtifactViewer } from "silverretort-chat-ui";

export function ArtifactPageClient({ artifactId }: { artifactId: string }) {
  return <ArtifactViewer artifactId={artifactId} />;
}
