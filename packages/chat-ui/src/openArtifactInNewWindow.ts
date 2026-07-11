export function artifactViewerPath(artifactId: string): string {
  return `/artifacts/${encodeURIComponent(artifactId)}`;
}

export function openArtifactInNewWindow(artifactId: string): Window | null {
  const url = new URL(artifactViewerPath(artifactId), window.location.href);
  const openedWindow = window.open(url.toString(), "_blank");
  openedWindow?.focus();
  return openedWindow;
}
