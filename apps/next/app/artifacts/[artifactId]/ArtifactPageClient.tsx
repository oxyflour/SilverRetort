"use client";

import { ArtifactViewer } from "silverretort-chat-ui";
import { registerAppArtifactRenderers } from "../../registerArtifactRenderers";

registerAppArtifactRenderers();

export function ArtifactPageClient({ artifactId }: { artifactId: string }) {
  return <ArtifactViewer artifactId={artifactId} />;
}
