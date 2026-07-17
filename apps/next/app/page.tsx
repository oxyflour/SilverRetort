"use client";

import { ChatApp } from "silverretort-chat-ui";
import { registerAppArtifactRenderers } from "./registerArtifactRenderers";

registerAppArtifactRenderers();

export default function Home() {
  return <ChatApp />;
}
