"use client";

import { Artifact } from "silverretort-protocol";
import { getArtifactRenderer } from "../registry";
import { registerBuiltinRenderers } from "../renderers/builtins";

registerBuiltinRenderers();

interface ArtifactContentProps {
  artifact: Artifact | null;
  loading?: boolean;
  loadingMessage?: string;
  emptyMessage?: string;
}

export function ArtifactContent({
  artifact,
  loading = false,
  loadingMessage = "Loading artifact...",
  emptyMessage = "No artifact selected",
}: ArtifactContentProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        {loadingMessage}
      </div>
    );
  }

  if (!artifact) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-neutral-400">
        {emptyMessage}
      </div>
    );
  }

  const Renderer = getArtifactRenderer(artifact.type);
  if (!Renderer) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-neutral-400">
        No renderer registered for "{artifact.type}"
      </div>
    );
  }

  return <Renderer artifact={artifact} />;
}
