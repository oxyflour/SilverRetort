"use client";

import { registerDemoArtifactRenderers } from "silverretort-artifact-ui-demo";
import { ChatApp } from "silverretort-chat-ui";

registerDemoArtifactRenderers();

// Register package-provided artifact renderers here.
export default function Home() {
  return <ChatApp />;
}
