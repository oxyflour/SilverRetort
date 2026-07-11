import { ArtifactPageClient } from "./ArtifactPageClient";

export default async function ArtifactPage({
  params,
}: {
  params: Promise<{ artifactId: string }>;
}) {
  const { artifactId } = await params;
  return <ArtifactPageClient artifactId={artifactId} />;
}
